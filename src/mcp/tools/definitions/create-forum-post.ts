import {
  ChannelType,
  type Client,
  type ForumChannel,
  type Message,
} from "discord.js";
import { getLifecycleController } from "../../../discord/client.js";
import { validateMessageContent } from "../../../discord/helpers.js";
import { appendTraceEvent } from "../../../shared/trace-audit.js";
import { ToolInputError, wrapToolExecutionError } from "../../errors.js";
import { defineTool, jsonResult } from "../registry.js";
import {
  validateOptionalString,
  validateRequiredString,
  validateStringArray,
} from "../validators.js";

function validateTitle(value: unknown): string {
  const title = validateRequiredString(value, "title").trim();
  if (title.length === 0) {
    throw new ToolInputError("title cannot be empty");
  }
  if (title.length > 100) {
    throw new ToolInputError("title must be 100 characters or fewer");
  }
  return title;
}

function validateAppliedTagIds(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  return validateStringArray(value, "appliedTagIds");
}

defineTool(
  {
    name: "create_forum_post",
    description:
      "Discordのフォーラムチャンネルに新しい投稿（トピック/スレッド）を作成します。既存トピックへの返信ではなく、新しい箱を作る用途です。",
    inputSchema: {
      type: "object",
      properties: {
        channelId: {
          type: "string",
          description: "親フォーラムチャンネルID",
        },
        title: {
          type: "string",
          description: "作成するフォーラム投稿のタイトル（100文字以内）",
        },
        content: {
          type: "string",
          description: "最初の投稿本文",
        },
        appliedTagIds: {
          type: "array",
          description: "適用するフォーラムタグIDの配列（任意）",
        },
        reason: {
          type: "string",
          description: "Discord監査ログ用の理由（任意）",
        },
      },
      required: ["channelId", "title", "content"],
    },
  },
  async (client: Client, args: Record<string, unknown>) => {
    const channelId = validateRequiredString(args.channelId, "channelId");
    const title = validateTitle(args.title);
    const content = validateMessageContent(args.content as string);
    const appliedTagIds = validateAppliedTagIds(args.appliedTagIds);
    const reason = validateOptionalString(args.reason, "reason");

    if (content.includes("@everyone") || content.includes("@here")) {
      throw new ToolInputError(
        "全体メンションを含むフォーラム投稿は作成できません。必要な場合は本文から @everyone/@here を外してください。",
      );
    }

    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel) {
        throw new ToolInputError("Channel not found");
      }
      if (channel.type !== ChannelType.GuildForum) {
        throw new ToolInputError("channelId must be a Discord forum channel");
      }

      const forumChannel = channel as ForumChannel;
      const thread = await forumChannel.threads.create({
        name: title,
        message: { content },
        appliedTags: appliedTagIds,
        reason,
      });

      let starterMessage: Message | null = null;
      try {
        starterMessage = await thread.messages.fetch(thread.id);
      } catch {
        starterMessage = null;
      }

      const controller = getLifecycleController();
      if (controller) {
        await controller.setFocusChannel(thread.id);
      }

      appendTraceEvent({
        event: "create_forum_post",
        channelId,
        threadId: thread.id,
        messageId: starterMessage?.id ?? thread.id,
        title,
        contentPreview: content,
        success: true,
      });

      return jsonResult({
        success: true,
        channelId,
        threadId: thread.id,
        messageId: starterMessage?.id ?? thread.id,
        title: thread.name,
        content: starterMessage?.content ?? content,
        parentId: thread.parentId,
        timestamp:
          starterMessage?.createdAt.toISOString() ??
          thread.createdAt?.toISOString() ??
          new Date().toISOString(),
      });
    } catch (error) {
      appendTraceEvent({
        event: "create_forum_post",
        channelId,
        title,
        contentPreview: content,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw wrapToolExecutionError(error, "create forum post");
    }
  },
);
