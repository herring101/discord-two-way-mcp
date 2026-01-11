import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const LOG_DIR = join(import.meta.dirname, "../../data/logs");
const LOG_FILE = join(LOG_DIR, "app.log");
const ERROR_LOG_FILE = join(LOG_DIR, "error.log");

// ログレベルの優先度
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

// 環境変数でログレベルを設定可能（デフォルト: INFO）
const currentLogLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "INFO";

/**
 * ログディレクトリを初期化
 */
function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

/**
 * ログメッセージをフォーマット
 */
function formatLog(
  level: LogLevel,
  module: string,
  message: string,
  args: unknown[],
): string {
  const timestamp = new Date().toISOString();
  const argsStr =
    args.length > 0
      ? ` ${args.map((a) => (a instanceof Error ? a.stack || a.message : JSON.stringify(a))).join(" ")}`
      : "";
  return `[${timestamp}] [${level.padEnd(5)}] [${module}] ${message}${argsStr}`;
}

/**
 * ログを出力（stderr + ファイル）
 */
function log(
  level: LogLevel,
  module: string,
  message: string,
  args: unknown[],
): void {
  // ログレベルフィルタリング
  if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[currentLogLevel]) {
    return;
  }

  const formatted = formatLog(level, module, message, args);

  // stderr に出力
  console.error(formatted);

  // ファイルに出力
  try {
    ensureLogDir();
    appendFileSync(LOG_FILE, `${formatted}\n`);

    // ERROR レベルは専用ファイルにも出力
    if (level === "ERROR") {
      appendFileSync(ERROR_LOG_FILE, `${formatted}\n`);
    }
  } catch {
    // ファイル書き込み失敗時は stderr のみで続行
  }
}

/**
 * モジュール用のロガーを取得
 * @param module モジュール名（例: "db", "discord", "mcp"）
 */
export function getLogger(module: string): Logger {
  return {
    debug: (message: string, ...args: unknown[]) =>
      log("DEBUG", module, message, args),
    info: (message: string, ...args: unknown[]) =>
      log("INFO", module, message, args),
    warn: (message: string, ...args: unknown[]) =>
      log("WARN", module, message, args),
    error: (message: string, ...args: unknown[]) =>
      log("ERROR", module, message, args),
  };
}
