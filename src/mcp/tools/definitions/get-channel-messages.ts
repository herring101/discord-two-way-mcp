import { type Client, DMChannel } from "discord.js";
import {
  getPrismaClient,
  saveMessages,
  updateAttachmentParsedContent,
} from "../../../db/client.js";
import { getLifecycleController } from "../../../discord/client.js";
import {
  fetchTextBasedChannel,
  validateAndLimitNumber,
} from "../../../discord/helpers.js";
import { isTrustedUser } from "../../../security/trust.js";
import { parseAttachment } from "../../../shared/attachment-parser.js";
import {
  type FormattableMessage,
  formatMessages,
} from "../../../shared/format.js";
import { getLogger } from "../../../shared/logger.js";
import { wrapToolExecutionError } from "../../errors.js";
import { defineTool, textResult } from "../registry.js";

const logger = getLogger("mcp");

// ツールを登録
defineTool(
  {
    name: "get_channel_messages",
    description: "Discordチャンネルから最近のメッセージを取得します",
    inputSchema: {
      type: "object",
      properties: {
        channelId: {
          type: "string",
          description: "DiscordチャンネルID",
        },
        limit: {
          type: "number",
          description: "取得するメッセージ数 (デフォルト: 10, 最大: 100)",
        },
      },
      required: ["channelId"],
    },
  },
  async (client: Client, args: Record<string, unknown>) => {
    const channelId = args.channelId as string;
    const limit = validateAndLimitNumber(
      args.limit as number | undefined,
      10,
      100,
    );

    try {
      const channel = await fetchTextBasedChannel(client, channelId);
      const messages = await channel.messages.fetch({ limit });
      const messageArray = [...messages.values()].reverse();

      // DBに自動キャッシュ（非同期、エラーは無視）
      saveMessages(messageArray).catch((error) => {
        logger.error("Failed to cache messages to DB:", error);
      });

      // focusチャンネルを切り替え、未読を既読化
      const controller = getLifecycleController();
      if (controller) {
        await controller.setFocusChannel(channelId);
        // 最新メッセージIDで既読化
        if (messageArray.length > 0) {
          const latestMessageId = messageArray[messageArray.length - 1].id;
          await controller.onChannelMessagesRead(channelId, latestMessageId);
        }
      }

      // チャンネル名を取得
      const channelName =
        channel instanceof DMChannel ? null : (channel.name ?? null);

      // DBから添付ファイルの解析結果を一括取得
      const messageIds = messageArray.map((msg) => msg.id);
      let dbAttachments: Array<{
        messageId: string;
        filename: string;
        parsedContent: string | null;
      }> = [];
      try {
        const prisma = getPrismaClient();
        dbAttachments = await prisma.attachment.findMany({
          where: { messageId: { in: messageIds } },
          select: { messageId: true, filename: true, parsedContent: true },
        });
      } catch {
        // DB未初期化等の場合は空のまま
      }

      // messageId+filename → parsedContent のマップを構築
      const parsedContentMap = new Map<string, string>();
      for (const att of dbAttachments) {
        if (att.parsedContent) {
          parsedContentMap.set(
            `${att.messageId}_${att.filename}`,
            att.parsedContent,
          );
        }
      }

      // parsedContent がない添付ファイルをオンデマンドで Gemini 解析
      const parsePromises: Promise<void>[] = [];
      for (const msg of messageArray) {
        for (const att of msg.attachments.values()) {
          const filename = att.name ?? "unknown";
          const key = `${msg.id}_${filename}`;
          if (!parsedContentMap.has(key) && att.url) {
            const promise = parseAttachment(
              att.url,
              att.contentType,
              filename,
            ).then((result) => {
              if (result.parsed && result.content) {
                parsedContentMap.set(key, result.content);
                // DB にも保存（fire-and-forget）
                updateAttachmentParsedContent(
                  msg.id,
                  filename,
                  result.content,
                ).catch((err) => {
                  logger.error(
                    `Failed to save parsedContent for ${filename}:`,
                    err,
                  );
                });
              }
            });
            parsePromises.push(promise);
          }
        }
      }
      // 全ての解析完了を待つ
      if (parsePromises.length > 0) {
        await Promise.allSettled(parsePromises);
      }

      // 各 author の trust 状態を一括解決 (重複排除して isTrustedUser 呼び出し最小化)
      const uniqueAuthorIds = [
        ...new Set(messageArray.map((m) => m.author.id)),
      ];
      const trustEntries = await Promise.all(
        uniqueAuthorIds.map(
          async (id) => [id, await isTrustedUser(id)] as const,
        ),
      );
      const trustMap = new Map(trustEntries);

      // FormattableMessage に変換
      const formattableMessages: FormattableMessage[] = messageArray.map(
        (msg) => ({
          id: msg.id,
          channelId: msg.channelId,
          channelName,
          author: {
            id: msg.author.id,
            username: msg.author.username,
            displayName: msg.member?.displayName ?? msg.author.username,
          },
          content: msg.content,
          timestamp: msg.createdAt,
          trusted: trustMap.get(msg.author.id) ?? false,
          attachments: msg.attachments.map((att) => {
            const filename = att.name ?? "unknown";
            const parsedContent = parsedContentMap.get(`${msg.id}_${filename}`);
            return {
              filename,
              parsedContent,
            };
          }),
          embeds: msg.embeds.map((embed) => ({
            title: embed.title,
            description: embed.description,
            url: embed.url,
            color: embed.color,
            author: embed.author
              ? { name: embed.author.name, url: embed.author.url }
              : null,
            footer: embed.footer ? { text: embed.footer.text } : null,
            fields: embed.fields.map((f) => ({
              name: f.name,
              value: f.value,
              inline: f.inline,
            })),
            image: embed.image ? { url: embed.image.url } : null,
            thumbnail: embed.thumbnail ? { url: embed.thumbnail.url } : null,
            timestamp: embed.timestamp,
          })),
          reactions: [...msg.reactions.cache.values()]
            .filter((r) => r.count > 0)
            .map((r) => ({
              emoji: r.emoji.name ?? r.emoji.toString(),
              count: r.count,
            })),
        }),
      );

      return textResult(formatMessages(formattableMessages));
    } catch (error) {
      throw wrapToolExecutionError(error, "fetch messages");
    }
  },
);
