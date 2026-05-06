import type { Client, Message } from "discord.js";
import { getLifecycleController } from "../../../discord/client.js";
import {
  fetchTextBasedChannel,
  validateMessageContent,
} from "../../../discord/helpers.js";
import {
  ToolInputError,
  ToolPreconditionError,
  wrapToolExecutionError,
} from "../../errors.js";
import { clearSendTarget, getSendTarget } from "../../state/send-target.js";
import { defineTool, jsonResult } from "../registry.js";

defineTool(
  {
    name: "send_message",
    description:
      "事前に set_send_target で設定したチャンネル/返信先にメッセージを送信します。set_send_target を呼んでいない場合はエラーになります。送信後は送信先設定が自動解除されます。",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "送信するメッセージ内容",
        },
        permit_everyone_mention: {
          type: "boolean",
          description:
            "@everyone/@here メンションを許可するかどうか（デフォルト: false）",
        },
      },
      required: ["content"],
    },
  },
  async (client: Client, args: Record<string, unknown>) => {
    const target = getSendTarget();
    if (!target) {
      throw new ToolPreconditionError(
        "送信先が設定されていません。先に set_send_target で channelId（と必要なら replyToMessageId）を指定してください。",
      );
    }

    const content = validateMessageContent(args.content as string);
    const permitEveryoneMention =
      (args.permit_everyone_mention as boolean) ?? false;

    if (
      !permitEveryoneMention &&
      (content.includes("@everyone") || content.includes("@here"))
    ) {
      throw new ToolInputError(
        "全体メンションが文章に含まれています。これを送信するとこのサーバーの全員に通知が行きます。それを理解したうえで送りたい場合は permit_everyone_mention を true にして送信してください。",
      );
    }

    try {
      const channel = await fetchTextBasedChannel(client, target.channelId);

      let sentMessage: Message;
      let originalMessage: {
        id: string;
        content: string;
        author: { username: string; id: string };
        timestamp: string;
      } | null = null;
      if (target.replyToMessageId) {
        const original = await channel.messages.fetch(target.replyToMessageId);
        if (!original) {
          throw new ToolInputError("Reply target message not found");
        }
        sentMessage = await original.reply(content);
        originalMessage = {
          id: original.id,
          content: original.content,
          author: {
            username: original.author.username,
            id: original.author.id,
          },
          timestamp: original.createdAt.toISOString(),
        };
      } else {
        sentMessage = await channel.send(content);
      }

      const controller = getLifecycleController();
      if (controller) {
        await controller.setFocusChannel(target.channelId);
      }

      clearSendTarget();

      return jsonResult({
        success: true,
        messageId: sentMessage.id,
        channelId: target.channelId,
        replyToMessageId: target.replyToMessageId ?? null,
        originalMessage,
        content: sentMessage.content,
        timestamp: sentMessage.createdAt.toISOString(),
      });
    } catch (error) {
      clearSendTarget();
      throw wrapToolExecutionError(error, "send message");
    }
  },
);
