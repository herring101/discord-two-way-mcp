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

const findEnvInAncestors = (key: string): string | undefined => {
  let currentPid = process.pid;

  for (let i = 0; i < 5; i++) {
    try {
      if (currentPid === process.pid && process.env[key]) {
        return process.env[key];
      }

      const environ = readFileSync(`/proc/${currentPid}/environ`, "utf-8");
      const match = environ
        .split("\0")
        .find((line) => line.startsWith(`${key}=`));
      if (match) {
        return match.slice(key.length + 1);
      }

      const stat = readFileSync(`/proc/${currentPid}/stat`, "utf-8");
      const lastParenIndex = stat.lastIndexOf(")");
      const parts = stat
        .substring(lastParenIndex + 1)
        .trim()
        .split(" ");
      const ppidStr = parts[1];
      if (!ppidStr) break;
      const ppid = Number.parseInt(ppidStr, 10);
      if (ppid === 0) break;
      currentPid = ppid;
    } catch {
      break;
    }
  }

  return undefined;
};

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
        sessionName: {
          type: "string",
          description:
            "再起動対象の tmux セッション名（例: codex-clamane）。自動解決できない場合に指定します。",
        },
        characterName: {
          type: "string",
          description:
            "再起動対象の bot 名（例: clamane）。指定時は codex-<name> セッションとして扱います。",
        },
      },
    },
  },
  async (_client: Client, args: Record<string, unknown>) => {
    const reason = validateOptionalString(args.reason, "reason");
    const sessionName = validateOptionalString(args.sessionName, "sessionName");
    const characterName = validateOptionalString(
      args.characterName,
      "characterName",
    );
    const target = resolveRestartTarget({
      env: process.env,
      readFile: (path) => readFileSync(path, "utf-8"),
      exists: existsSync,
      findEnv: findEnvInAncestors,
      requestedCharacterName: characterName,
      requestedSessionName: sessionName,
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
