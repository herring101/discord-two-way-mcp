import { type Client, DMChannel } from "discord.js";
import { saveMessages } from "../../../db/client.js";
import { getLifecycleController } from "../../../discord/client.js";
import {
  fetchTextBasedChannel,
  validateAndLimitNumber,
  wrapError,
} from "../../../discord/helpers.js";
import {
  type FormattableMessage,
  formatMessages,
} from "../../../shared/format.js";
import { getLogger } from "../../../shared/logger.js";
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

      // focusチャンネルを切り替え
      const controller = getLifecycleController();
      if (controller) {
        await controller.setFocusChannel(channelId);
      }

      // チャンネル名を取得
      const channelName =
        channel instanceof DMChannel ? null : (channel.name ?? null);

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
          attachments: msg.attachments.map((att) => ({
            filename: att.name ?? "unknown",
          })),
        }),
      );

      return textResult(formatMessages(formattableMessages));
    } catch (error) {
      throw wrapError(error, "fetch messages");
    }
  },
);
