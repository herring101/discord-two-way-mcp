import { execSync } from "node:child_process";

/**
 * 現在のtmuxセッション名を取得
 * tmux外で実行されている場合はnullを返す
 */
export function getTmuxSession(): string | null {
  if (!process.env.TMUX) {
    return null;
  }

  try {
    return execSync("tmux display-message -p '#S'", {
      encoding: "utf-8",
    }).trim();
  } catch {
    return null;
  }
}

/**
 * tmuxセッションにメッセージを送信
 */
export function sendToTmux(sessionName: string, message: string): boolean {
  try {
    // メッセージ内のシングルクォートをエスケープ
    const escapedMessage = message.replace(/'/g, "'\\''");
    execSync(`tmux send-keys -t '${sessionName}' '${escapedMessage}' Enter`, {
      encoding: "utf-8",
    });
    return true;
  } catch (error) {
    console.error("Failed to send message to tmux:", error);
    return false;
  }
}
