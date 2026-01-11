import type { Client } from "discord.js";
import { saveMessages } from "../utils/database.js";
import {
  fetchTextBasedChannel,
  transformMessage,
  validateAndLimitNumber,
  wrapError,
} from "../utils/discord.js";
import { defineTool, jsonResult } from "./registry.js";

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
      const messageArray = [...messages.values()];
      const messageList = messageArray.reverse().map(transformMessage);

      // DBに自動キャッシュ（非同期、エラーは無視）
      saveMessages(messageArray).catch((error) => {
        console.error("Failed to cache messages to DB:", error);
      });

      return jsonResult({ messages: messageList });
    } catch (error) {
      throw wrapError(error, "fetch messages");
    }
  },
);
