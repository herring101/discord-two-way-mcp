import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Client } from "discord.js";
import { getLifecycleController } from "../../../discord/client.js";
import {
  fetchTextBasedChannel,
  validateMessageContent,
  wrapError,
} from "../../../discord/helpers.js";
import { defineTool, jsonResult } from "../registry.js";

// ツールを登録
defineTool(
  {
    name: "reply_to_message",
    description: "特定のDiscordメッセージに返信します",
    inputSchema: {
      type: "object",
      properties: {
        channelId: {
          type: "string",
          description: "DiscordチャンネルID",
        },
        messageId: {
          type: "string",
          description: "返信先のメッセージID",
        },
        content: {
          type: "string",
          description: "返信内容",
        },
      },
      required: ["channelId", "messageId", "content"],
    },
  },
  async (client: Client, args: Record<string, unknown>) => {
    const channelId = args.channelId as string;
    const messageId = args.messageId as string;
    const content = validateMessageContent(args.content as string);

    try {
      const channel = await fetchTextBasedChannel(client, channelId);
      const originalMessage = await channel.messages.fetch(messageId);

      if (!originalMessage) {
        throw new McpError(ErrorCode.InvalidParams, "Message not found");
      }

      const reply = await originalMessage.reply(content);

      // focusチャンネルを切り替え
      const controller = getLifecycleController();
      if (controller) {
        await controller.setFocusChannel(channelId);
      }

      return jsonResult({
        success: true,
        replyId: reply.id,
        originalMessageId: messageId,
        originalMessage: {
          content: originalMessage.content,
          author: {
            username: originalMessage.author.username,
            id: originalMessage.author.id,
          },
          timestamp: originalMessage.createdAt.toISOString(),
        },
        content: reply.content,
        timestamp: reply.createdAt.toISOString(),
      });
    } catch (error) {
      throw wrapError(error, "reply to message");
    }
  },
);
