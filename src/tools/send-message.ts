import type { Client } from "discord.js";
import {
  fetchTextBasedChannel,
  validateMessageContent,
  wrapError,
} from "../utils/discord.js";
import { defineTool, jsonResult } from "./registry.js";

// ツールを登録
defineTool(
  {
    name: "send_message",
    description: "Discordチャンネルにメッセージを送信します",
    inputSchema: {
      type: "object",
      properties: {
        channelId: {
          type: "string",
          description: "DiscordチャンネルID",
        },
        content: {
          type: "string",
          description: "送信するメッセージ内容",
        },
      },
      required: ["channelId", "content"],
    },
  },
  async (client: Client, args: Record<string, unknown>) => {
    const channelId = args.channelId as string;
    const content = validateMessageContent(args.content as string);

    try {
      const channel = await fetchTextBasedChannel(client, channelId);
      const sentMessage = await channel.send(content);

      return jsonResult({
        success: true,
        messageId: sentMessage.id,
        content: sentMessage.content,
        timestamp: sentMessage.createdAt.toISOString(),
      });
    } catch (error) {
      throw wrapError(error, "send message");
    }
  },
);
