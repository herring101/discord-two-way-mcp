/**
 * MCP tool 入力検証の共通バリデータ集 (HER-83)
 *
 * 各 tool の handler 冒頭で散在していた入力チェックを集約。
 * 失敗時は MCP 仕様に沿った `McpError(InvalidParams, ...)` を投げる。
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

/**
 * action 等の enum 文字列を検証する。
 * @throws McpError InvalidParams: value が allowed に含まれない
 */
export function validateActionEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fieldName = "action",
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${fieldName} は ${allowed.join(" / ")} のいずれかである必要があります（受信: ${String(value)}）`,
    );
  }
  return value as T;
}

/**
 * 必須文字列を検証する。null / undefined / 非文字列 / 空文字列を弾く。
 * @throws McpError InvalidParams: 不正値
 */
export function validateRequiredString(
  value: unknown,
  fieldName: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${fieldName} は必須の文字列です（受信: ${String(value)}）`,
    );
  }
  return value;
}

/**
 * オプション文字列を検証する。undefined はそのまま、値があれば string 型を確認。
 * @throws McpError InvalidParams: 値があるが文字列でない
 */
export function validateOptionalString(
  value: unknown,
  fieldName: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${fieldName} は文字列で指定してください（受信: ${typeof value}）`,
    );
  }
  return value;
}

/**
 * channelId / guildId の少なくとも一方が必要なケースを検証する。
 * (search_messages, get_channel_messages 等で使用)
 * @throws McpError InvalidParams: 両方欠損
 */
export function validateChannelOrGuild(args: Record<string, unknown>): {
  channelId?: string;
  guildId?: string;
} {
  const channelId = validateOptionalString(args.channelId, "channelId");
  const guildId = validateOptionalString(args.guildId, "guildId");
  if (!channelId && !guildId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "channelId または guildId のいずれかが必要です",
    );
  }
  return { channelId, guildId };
}

/**
 * 数値を [min, max] の範囲にクランプして返す。
 * value が undefined / 非数値の場合は defaultValue を採用。
 */
export function clampNumberInRange(
  value: unknown,
  options: { min: number; max: number; default: number },
): number {
  const { min, max, default: defaultValue } = options;
  const num =
    typeof value === "number" && !Number.isNaN(value) ? value : defaultValue;
  return Math.min(Math.max(num, min), max);
}

/**
 * ISO 8601 日時文字列を Date に変換する。
 * @throws McpError InvalidParams: 値が文字列でない or parse 不可
 */
export function validateIso8601Date(value: unknown, fieldName: string): Date {
  const str = validateRequiredString(value, fieldName);
  const date = new Date(str);
  if (Number.isNaN(date.getTime())) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${fieldName} の形式が不正です。ISO 8601 形式で指定してください（受信: ${str}）`,
    );
  }
  return date;
}

/**
 * 文字列配列 (各要素が必須文字列) を検証する。
 * @throws McpError InvalidParams: 配列でない / 要素が文字列でない / 要素が空
 */
export function validateStringArray(
  value: unknown,
  fieldName: string,
): string[] {
  if (!Array.isArray(value)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${fieldName} は文字列配列で指定してください（受信: ${typeof value}）`,
    );
  }
  return value.map((v, i) => validateRequiredString(v, `${fieldName}[${i}]`));
}
