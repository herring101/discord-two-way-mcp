/**
 * Discord MCP 再起動ツール
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { Client } from "discord.js";
import { getLogger } from "../../../shared/logger.js";
import { defineTool, jsonResult } from "../registry.js";
import { resolveRestartTarget } from "../restart-discord-mcp-core.js";
import { validateOptionalString } from "../validators.js";

const logger = getLogger("mcp");

defineTool(
  {
    name: "restart_discord_mcp",
    description:
      "現在の bot セッションで使っている Discord MCP を反映・復旧するため、外部 supervisor (`launch.sh restart <bot>`) に現在の bot セッション再起動を依頼します。対象は戻り値の target/session/mode に明示されます。proxy は使いません。",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "再起動理由（任意、戻り値とログに記録されます）",
        },
      },
    },
  },
  async (_client: Client, args: Record<string, unknown>) => {
    const reason = validateOptionalString(args.reason, "reason");
    const target = resolveRestartTarget({
      env: process.env,
      readFile: (path) => readFileSync(path, "utf-8"),
      exists: existsSync,
    });

    if ("error" in target) {
      return jsonResult({
        success: false,
        target: "discord-two-way-mcp",
        mode: "supervisor-detached",
        error: target.error,
      });
    }

    if (!existsSync(target.launchScriptPath)) {
      return jsonResult({
        success: false,
        target: "discord-two-way-mcp",
        mode: "supervisor-detached",
        session: target.sessionName,
        character: target.characterName,
        error: `launch.sh が見つかりません: ${target.launchScriptPath}`,
      });
    }

    const child = spawn(
      "bash",
      [target.launchScriptPath, "restart", target.characterName],
      {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          DISCORD_MCP_RESTART_REASON: reason ?? "",
        },
      },
    );
    child.unref();

    logger.info(
      `restart_discord_mcp scheduled: session=${target.sessionName} character=${target.characterName} pid=${child.pid} reason="${reason ?? ""}"`,
    );

    return jsonResult({
      success: true,
      target: "discord-two-way-mcp",
      mode: "supervisor-detached",
      session: target.sessionName,
      character: target.characterName,
      launchScriptPath: target.launchScriptPath,
      supervisorPid: child.pid,
      reason: reason ?? null,
      message:
        "外部 supervisor に再起動を依頼しました。この tool response 返却後、現在の bot セッションは数秒後に停止し、新しいセッションで再開メッセージが投入されます。",
    });
  },
  { requiresDiscord: false },
);
