import type { Client } from "discord.js";
import { fetchTextBasedChannel } from "../../../discord/helpers.js";
import { ToolInputError, wrapToolExecutionError } from "../../errors.js";
import { defineTool, jsonResult } from "../registry.js";

// ツールを登録
defineTool(
  {
    name: "add_reaction",
    description: "Discordメッセージにリアクションを追加します",
    inputSchema: {
      type: "object",
      properties: {
        channelId: {
          type: "string",
          description: "DiscordチャンネルID",
        },
        messageId: {
          type: "string",
          description: "メッセージID",
        },
        emoji: {
          type: "string",
          description:
            "リアクションする絵文字（Unicode絵文字またはカスタム絵文字形式）",
        },
      },
      required: ["channelId", "messageId", "emoji"],
    },
  },
  async (client: Client, args: Record<string, unknown>) => {
    const channelId = args.channelId as string;
    const messageId = args.messageId as string;
    const emoji = args.emoji as string;

    try {
      const channel = await fetchTextBasedChannel(client, channelId);
      const message = await channel.messages.fetch(messageId);

      if (!message) {
        throw new ToolInputError("Message not found");
      }

      const reaction = await message.react(emoji);

      return jsonResult({
        success: true,
        emoji: reaction.emoji.toString(),
        messageId,
      });
    } catch (error) {
      throw wrapToolExecutionError(error, "add reaction");
    }
  },
);
