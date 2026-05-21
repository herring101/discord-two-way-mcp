import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { getLogger } from "./logger.js";

const logger = getLogger("tmux");

/**
 * 現在のtmuxセッション名を取得
 * launch scripts pass TMUX_SESSION_FILE because MCP child processes may not
 * inherit TMUX. Without it, `tmux display-message #S` can resolve to another
 * attached session when multiple bots are running.
 */
export function getTmuxSession(): string | null {
  const sessionFile = process.env.TMUX_SESSION_FILE;
  if (sessionFile) {
    try {
      const sessionName = readFileSync(sessionFile, "utf-8").trim();
      if (sessionName) return sessionName;
    } catch (error) {
      logger.warn(`Failed to read TMUX_SESSION_FILE ${sessionFile}:`, error);
      return null;
    }
  }

  const sessionByTty = getTmuxSessionByProcessTty();
  if (sessionByTty) return sessionByTty;

  if (!process.env.TMUX) return null;

  try {
    const sessionName = execFileSync("tmux", ["display-message", "-p", "#S"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    return sessionName || null;
  } catch {
    return null;
  }
}

function getTmuxSessionByProcessTty(): string | null {
  try {
    const tty = execFileSync("ps", ["-p", String(process.pid), "-o", "tty="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (!tty || tty === "?") return null;

    const ttyPath = tty.startsWith("/") ? tty : `/dev/${tty}`;
    const panes = execFileSync(
      "tmux",
      ["list-panes", "-a", "-F", "#S #{pane_tty}"],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    )
      .trim()
      .split("\n")
      .filter(Boolean);

    const match = panes
      .map((line) => {
        const [sessionName, paneTty] = line.split(" ");
        return { sessionName, paneTty };
      })
      .find(({ paneTty }) => paneTty === ttyPath);

    return match?.sessionName ?? null;
  } catch {
    return null;
  }
}

/**
 * tmuxセッションにメッセージを送信
 * メッセージ送信後1秒待ってから改行を送信する
 */
export function sendToTmux(sessionName: string, message: string): boolean {
  try {
    const { execSync } = require("node:child_process");
    const escapedMessage = message.replace(/'/g, "'\\''");
    execSync(`tmux send-keys -t '${sessionName}' '${escapedMessage}' Enter`, {
      encoding: "utf-8",
    });

    // 1秒後に改行を送信（非同期）
    setTimeout(() => {
      try {
        execSync(`tmux send-keys -t '${sessionName}' Enter`, {
          encoding: "utf-8",
        });
      } catch {
        // 改行送信の失敗は無視
      }
    }, 1000);

    return true;
  } catch (error) {
    logger.error("Failed to send message to tmux:", error);
    return false;
  }
}
