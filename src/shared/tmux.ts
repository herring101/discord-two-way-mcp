import { execFileSync } from "node:child_process";
import { getLogger } from "./logger.js";

const logger = getLogger("tmux");

/**
 * 現在のtmuxセッション名を取得
 * tmux 自身が持つ現在セッション名を正本にする。
 */
export function getTmuxSession(): string | null {
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
