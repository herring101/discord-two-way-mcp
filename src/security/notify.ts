/**
 * notify_owner ツールの純粋ロジック部分。
 * Discord 副作用を切り離してテスト可能にする。
 */

export type Severity = "info" | "warn" | "threat";

export const SEVERITIES: readonly Severity[] = ["info", "warn", "threat"];

export const SEVERITY_COLOR: Record<Severity, number> = {
  info: 0x3498db, // blue
  warn: 0xf1c40f, // yellow
  threat: 0xe74c3c, // red
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  info: "ℹ️ INFO",
  warn: "⚠️ WARN",
  threat: "🚨 THREAT",
};

/**
 * Embed description の安全しきい値。
 * Discord 仕様上は 4096 だが、HER-77 仕様で 2000 字を分割境界とする。
 */
export const EMBED_CHUNK_LIMIT = 2000;

/**
 * severity 文字列を検証して返す。不正な値ならエラー。
 */
export function parseSeverity(value: unknown): Severity {
  if (value === undefined || value === null) return "info";
  if (typeof value !== "string") {
    throw new Error(
      `severity は文字列である必要があります（受信: ${typeof value}）`,
    );
  }
  if (!(SEVERITIES as readonly string[]).includes(value)) {
    throw new Error(
      `severity は ${SEVERITIES.join(" / ")} のいずれかである必要があります（受信: ${value}）`,
    );
  }
  return value as Severity;
}

/**
 * 文字列を maxLen で分割する。空入力は空配列を返す。
 * 単純な固定長分割（コードブロック等の言語的境界は考慮しない）。
 */
export function splitMessage(message: string, maxLen: number): string[] {
  if (maxLen <= 0) {
    throw new Error(`maxLen は正の整数である必要があります: ${maxLen}`);
  }
  if (message.length === 0) return [];
  const chunks: string[] = [];
  for (let i = 0; i < message.length; i += maxLen) {
    chunks.push(message.slice(i, i + maxLen));
  }
  return chunks;
}

export interface NotificationEmbedSpec {
  title: string;
  description: string;
  color: number;
  footer?: string;
}

/**
 * 通知本文から、送信用 Embed の仕様を組み立てる（副作用なし）。
 *
 * - 1 通目に severity ラベル + category を含むタイトル
 * - 分割時は (n/N) を付与
 * - footer は最終 Embed のみ
 */
export function buildNotificationEmbeds(input: {
  message: string;
  severity: Severity;
  category?: string;
}): NotificationEmbedSpec[] {
  const chunks = splitMessage(input.message, EMBED_CHUNK_LIMIT);
  if (chunks.length === 0) {
    throw new Error("message が空です。");
  }
  const total = chunks.length;
  const color = SEVERITY_COLOR[input.severity];
  const baseTitle = SEVERITY_LABEL[input.severity];
  const titleSuffix = input.category ? ` · ${input.category}` : "";

  return chunks.map((chunk, idx) => {
    const indexLabel = total > 1 ? ` (${idx + 1}/${total})` : "";
    return {
      title: `${baseTitle}${titleSuffix}${indexLabel}`,
      description: chunk,
      color,
      footer:
        idx === total - 1 ? `notify_owner · ${input.severity}` : undefined,
    };
  });
}
