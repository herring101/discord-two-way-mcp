import type { Client } from "discord.js";
import { clearSendTarget, getSendTarget } from "../../state/send-target.js";
import { defineTool, jsonResult } from "../registry.js";

defineTool(
  {
    name: "clear_send_target",
    description:
      "送信先設定と「入力中…」表示を解除します。送信をキャンセルしたいときに呼びます。",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  async (_client: Client, _args: Record<string, unknown>) => {
    const previous = getSendTarget();
    clearSendTarget();
    return jsonResult({
      success: true,
      cleared: previous ?? null,
      typing: "inactive",
    });
  },
);
