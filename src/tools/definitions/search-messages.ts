import type { Client } from "discord.js";
import { getPrismaClient } from "../../utils/database.js";
import { wrapError } from "../../utils/discord.js";
import { type FormattableMessage, formatMessages } from "../../utils/format.js";
import { defineTool, textResult } from "../registry.js";

// ツールを登録
defineTool(
  {
    name: "search_messages",
    description:
      "データベースに保存されたメッセージを検索します。テキスト検索、著者フィルタ、日時フィルタをサポート。",
    inputSchema: {
      type: "object",
      properties: {
        channelId: {
          type: "string",
          description:
            "DiscordチャンネルID（channelIdまたはguildIdのいずれか必須）",
        },
        guildId: {
          type: "string",
          description:
            "DiscordギルドID（channelIdまたはguildIdのいずれか必須）",
        },
        query: {
          type: "string",
          description: "検索クエリ（メッセージ内容に含まれるテキスト）",
        },
        authorId: {
          type: "string",
          description: "著者IDでフィルタ",
        },
        hasLink: {
          type: "boolean",
          description: "リンクを含むメッセージのみ",
        },
        hasAttachment: {
          type: "boolean",
          description: "添付ファイルを含むメッセージのみ",
        },
        limit: {
          type: "number",
          description: "最大件数（デフォルト: 20, 最大: 100）",
        },
        sortBy: {
          type: "string",
          description: "ソート順: 'newest'（デフォルト）または 'oldest'",
          enum: ["newest", "oldest"],
        },
        dateFrom: {
          type: "string",
          description:
            "開始日時（ISO 8601形式: YYYY-MM-DD または YYYY-MM-DDTHH:mm:ss）",
        },
        dateTo: {
          type: "string",
          description: "終了日時（ISO 8601形式）",
        },
      },
    },
  },
  async (_client: Client, args: Record<string, unknown>) => {
    const channelId = args.channelId as string | undefined;
    const guildId = args.guildId as string | undefined;
    const query = args.query as string | undefined;
    const authorId = args.authorId as string | undefined;
    const hasLink = args.hasLink as boolean | undefined;
    const hasAttachment = args.hasAttachment as boolean | undefined;
    const limit = Math.min(Math.max((args.limit as number) || 20, 1), 100);
    const sortBy = (args.sortBy as "newest" | "oldest") || "newest";
    const dateFrom = args.dateFrom as string | undefined;
    const dateTo = args.dateTo as string | undefined;

    if (!channelId && !guildId) {
      return textResult(
        "エラー: channelId または guildId のいずれかが必要です",
      );
    }

    try {
      const prisma = getPrismaClient();

      // 検索条件を構築
      const where: Record<string, unknown> = {};
      if (channelId) where.channelId = channelId;
      if (guildId) where.guildId = guildId;
      if (authorId) where.authorId = authorId;
      if (hasLink !== undefined) where.hasLink = hasLink;
      if (hasAttachment !== undefined) where.hasAttachment = hasAttachment;

      // テキスト検索
      if (query) {
        where.content = { contains: query };
      }

      // 日時フィルタ
      if (dateFrom || dateTo) {
        const timestampFilter: Record<string, Date> = {};
        if (dateFrom) timestampFilter.gte = new Date(dateFrom);
        if (dateTo) timestampFilter.lte = new Date(dateTo);
        where.timestamp = timestampFilter;
      }

      const messages = await prisma.message.findMany({
        where,
        orderBy: { timestamp: sortBy === "newest" ? "desc" : "asc" },
        take: limit,
        include: {
          attachments: true,
          channel: true,
        },
      });

      // FormattableMessage に変換
      const formattableMessages: FormattableMessage[] = messages.map((msg) => ({
        id: msg.id,
        channelId: msg.channelId,
        channelName: msg.channel.name,
        author: {
          id: msg.authorId,
          username: msg.authorUsername,
          displayName: msg.authorDisplayName ?? msg.authorUsername,
        },
        content: msg.content,
        timestamp: msg.timestamp,
        attachments: msg.attachments.map((att) => ({
          filename: att.filename,
        })),
      }));

      // oldestの場合は時系列順（古い→新しい）に並び替え
      const sortedMessages =
        sortBy === "oldest" ? formattableMessages : formattableMessages;

      return textResult(formatMessages(sortedMessages));
    } catch (error) {
      throw wrapError(error, "search messages");
    }
  },
);
