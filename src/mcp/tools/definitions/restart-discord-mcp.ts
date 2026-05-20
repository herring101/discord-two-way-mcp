/**
 * Discord 接続の soft restart tool。
 *
 * MCP プロセスや外部 supervisor には依存せず、discord.js client だけを
 * destroy -> recreate -> login する。
 */

import type { Client } from "discord.js";
import { defineTool, jsonResult } from "../registry.js";
import { validateOptionalString } from "../validators.js";

defineTool(
  {
    name: "restart_discord_mcp",
    description:
      "Discord MCP の Discord 接続だけを soft restart します。MCP プロセスや外部 supervisor は再起動しません。",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "再起動理由（任意、ログと戻り値に記録されます）",
        },
      },
    },
  },
  async (_client: Client, args: Record<string, unknown>, context) => {
    const reason = validateOptionalString(args.reason, "reason");

    if (!context.restartDiscord) {
      return jsonResult({
        success: false,
        target: "discord-connection",
        mode: "soft-restart",
        reason: reason ?? null,
        error: "Discord restart handler is not available",
      });
    }

    await context.restartDiscord(reason);

    return jsonResult({
      success: true,
      target: "discord-connection",
      mode: "soft-restart",
      reason: reason ?? null,
      message:
        "Discord 接続を再初期化しました。MCP プロセスや外部 supervisor は再起動していません。",
    });
  },
  { requiresDiscord: false },
);
