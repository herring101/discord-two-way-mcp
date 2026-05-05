/**
 * 信頼ユーザー判定。trusted は命令解釈を許す、untrusted はメッセージ本文をラップする。
 *
 * 起点（HER-73 時点）:
 *   - env `INITIAL_TRUSTED_USER_IDS` (カンマ区切り)
 *   - OwnerConfig.ownerUserId（owner は常に trusted）
 *
 * HER-74 で `TrustedUser` テーブルからの DB lookup が追加されるが、
 * 外側 API (`isTrustedUser`) は同じシグネチャを保つ。
 */

import { getOwnerConfig } from "./config.js";

let cached: Set<string> | null = null;

/**
 * env 文字列を user ID 配列にパースする（純関数）。
 * - undefined / 空文字列 → []
 * - カンマ区切り、各要素 trim、空要素は除外
 */
export function parseTrustedUserIdsFromEnv(
  envValue: string | undefined,
): string[] {
  if (!envValue) return [];
  return envValue
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function loadTrustedUserIds(): Promise<Set<string>> {
  const fromEnv = parseTrustedUserIdsFromEnv(
    process.env.INITIAL_TRUSTED_USER_IDS,
  );
  const set = new Set<string>(fromEnv);

  // owner は常に trusted。OwnerConfig が未初期化なら無視（テスト時など）。
  try {
    const config = await getOwnerConfig();
    set.add(config.ownerUserId);
  } catch {
    // OwnerConfig 未設定 → owner なしで進む
  }

  return set;
}

/**
 * userId が trusted かどうかを返す。
 * 初回呼び出しでメモリキャッシュを作る。
 */
export async function isTrustedUser(userId: string): Promise<boolean> {
  if (cached === null) {
    cached = await loadTrustedUserIds();
  }
  return cached.has(userId);
}

/**
 * メモリキャッシュを破棄する。
 * - HER-74 で trusted 追加/削除時に呼ぶ
 * - テストでも使う
 */
export function resetTrustCache(): void {
  cached = null;
}
