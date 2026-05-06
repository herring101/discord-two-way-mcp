import type { Client } from "discord.js";
import { wrapToolExecutionError } from "../../errors.js";
import { setSendTarget } from "../../state/send-target.js";
import { defineTool, jsonResult } from "../registry.js";

defineTool(
  {
    name: "set_send_target",
    description:
      "次の send_message の送信先を事前設定し、Discord に「入力中…」表示を出します。replyToMessageId を渡すと返信になります。再度呼べば送信先を切り替えられます。",
    inputSchema: {
      type: "object",
      properties: {
        channelId: {
          type: "string",
          description: "送信先 Discord チャンネル ID",
        },
        replyToMessageId: {
          type: "string",
          description: "返信先メッセージ ID（省略時は通常の送信）",
        },
      },
      required: ["channelId"],
    },
  },
  async (client: Client, args: Record<string, unknown>) => {
    const channelId = args.channelId as string;
    const replyToMessageId = args.replyToMessageId as string | undefined;

    try {
      await setSendTarget(client, { channelId, replyToMessageId });
      return jsonResult({
        success: true,
        channelId,
        replyToMessageId: replyToMessageId ?? null,
        typing: "active",
      });
    } catch (error) {
      throw wrapToolExecutionError(error, "set send target");
    }
  },
);
