import { readFileSync } from "node:fs";

/**
 * プロセスツリーを遡って特定の環境変数の値を取得する
 * 自分のプロセスから開始し、最大5階層まで親を探索する
 */
const findEnvInAncestors = (key: string): string | null => {
  let currentPid = process.pid;

  for (let i = 0; i < 5; i++) {
    try {
      // 0. 自分自身の場合は process.env を優先チェック
      if (currentPid === process.pid && process.env[key]) {
        return process.env[key] ?? null;
      }

      // 1. 環境変数を探す (/proc/<PID>/environ)
      const environ = readFileSync(`/proc/${currentPid}/environ`, "utf-8");
      // environはnull文字区切り: KEY=VALUE\0KEY=VALUE...
      const match = environ
        .split("\0")
        .find((line) => line.startsWith(`${key}=`));

      if (match) {
        return match.split("=")[1] ?? null;
      }

      // 2. 次の親PIDを取得 (/proc/<PID>/stat)
      // statフォーマット: pid (comm) state ppid ...
      const stat = readFileSync(`/proc/${currentPid}/stat`, "utf-8");
      // カッコ内のコマンド名にスペースが含まれる可能性を考慮し、最後の ')' を探す
      const lastParenIndex = stat.lastIndexOf(")");
      const parts = stat.substring(lastParenIndex + 1).trim().split(" ");
      const ppidStr = parts[1];
      if (!ppidStr) break;
      const ppid = parseInt(ppidStr, 10);

      if (ppid === 0) break; // 親なし (init/kernel)
      currentPid = ppid;
    } catch (error) {
      // 権限エラーやプロセス消失などは無視して探索終了
      break;
    }
  }
  return null;
};

/**
 * 現在のtmuxセッション名を取得
 * Always Look Up: 自分を含むプロセスツリーから環境変数 TMUX_SESSION_FILE を探索し、
 * 見つかったファイルのパスからセッション名を読み取る。
 */
export function getTmuxSession(): string | null {
  const sessionFile = findEnvInAncestors("TMUX_SESSION_FILE");

  if (!sessionFile) {
    return null;
  }

  try {
    return readFileSync(sessionFile, "utf-8").trim();
  } catch {
    return null;
  }
}

/**
 * tmuxセッションにメッセージを送信
 */
export function sendToTmux(sessionName: string, message: string): boolean {
  try {
    const { execSync } = require("node:child_process");
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
