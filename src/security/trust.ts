/**
 * 信頼ユーザー判定。trusted は命令解釈を許す、untrusted はメッセージ本文をラップする。
 *
 * trusted の起点:
 *   - env `INITIAL_TRUSTED_USER_IDS` (カンマ区切り)
 *   - Bot 自身の user.id（`setBotUserId` で clientReady 時に登録）
 *   - OwnerConfig.ownerUserId（owner は常に trusted）
 *   - `TrustedUser` テーブル（HER-74 で `manage_trust` から CRUD）
 *
 * 外側 API (`isTrustedUser`) は同じシグネチャを保つ。
 */

import { getPrismaClient } from "../db/client.js";
import { getOwnerConfig } from "./config.js";

let cached: Set<string> | null = null;
let botUserId: string | null = null;

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

  // Bot 自身 (clientReady 時に setBotUserId される) は常に trusted。
  if (botUserId) set.add(botUserId);

  // owner は常に trusted。OwnerConfig が未初期化なら無視（テスト時など）。
  try {
    const config = await getOwnerConfig();
    set.add(config.ownerUserId);
  } catch {
    // OwnerConfig 未設定 → owner なしで進む
  }

  // TrustedUser テーブル (manage_trust で追加されたもの)
  try {
    const rows = await getPrismaClient().trustedUser.findMany({
      select: { userId: true },
    });
    for (const row of rows) set.add(row.userId);
  } catch {
    // DB 未初期化（テスト時など）→ TrustedUser テーブル分を無視して進む
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
 * メモリキャッシュを破棄する。trusted 追加/削除時に呼ぶ。
 */
export function resetTrustCache(): void {
  cached = null;
}

/**
 * Bot 自身の Discord user.id を trusted に登録する。
 * Discord client の clientReady で呼ばれる前提。null でクリア。
 */
export function setBotUserId(id: string | null): void {
  botUserId = id;
  cached = null;
}

/**
 * trusted の出処を表すソース文字列。
 * - "env": INITIAL_TRUSTED_USER_IDS 由来
 * - "owner": OwnerConfig.ownerUserId
 * - "bot": setBotUserId 経由の Bot 自身
 * - "<userId>" or "manage_trust": TrustedUser テーブルの addedBy
 */
export interface TrustedUserEntry {
  userId: string;
  source: string;
  addedAt?: Date;
  note?: string | null;
}

/**
 * 全 trusted エントリを source 付きで返す。
 * env / bot / owner / DB を統合し、source の優先順位は env > owner > bot > DB の順で 1 行だけ返す。
 */
export async function listTrustedUsers(): Promise<TrustedUserEntry[]> {
  const map = new Map<string, TrustedUserEntry>();

  // env
  for (const id of parseTrustedUserIdsFromEnv(
    process.env.INITIAL_TRUSTED_USER_IDS,
  )) {
    map.set(id, { userId: id, source: "env" });
  }

  // owner
  try {
    const config = await getOwnerConfig();
    if (!map.has(config.ownerUserId)) {
      map.set(config.ownerUserId, {
        userId: config.ownerUserId,
        source: "owner",
      });
    }
  } catch {}

  // bot
  if (botUserId && !map.has(botUserId)) {
    map.set(botUserId, { userId: botUserId, source: "bot" });
  }

  // DB
  try {
    const rows = await getPrismaClient().trustedUser.findMany();
    for (const row of rows) {
      if (!map.has(row.userId)) {
        map.set(row.userId, {
          userId: row.userId,
          source: row.addedBy ?? "manage_trust",
          addedAt: row.addedAt,
          note: row.note,
        });
      }
    }
  } catch {}

  return [...map.values()];
}

/**
 * TrustedUser テーブルに userIds を追加（既存は note / addedBy のみ更新）。
 */
export async function addTrustedUsers(
  userIds: string[],
  addedBy: string,
  note?: string,
): Promise<{ added: string[] }> {
  const db = getPrismaClient();
  const added: string[] = [];
  for (const userId of userIds) {
    await db.trustedUser.upsert({
      where: { userId },
      update: { addedBy, note: note ?? null },
      create: { userId, addedBy, note: note ?? null },
    });
    added.push(userId);
  }
  resetTrustCache();
  return { added };
}

/**
 * TrustedUser テーブルから userIds を削除。
 * 実在しなかった ID は notFound として返す。
 * env / owner / bot 由来は DB に行が無いので削除されない（注意喚起のため呼び出し側で表示推奨）。
 */
export async function removeTrustedUsers(
  userIds: string[],
): Promise<{ removed: string[]; notFound: string[] }> {
  const db = getPrismaClient();
  const existing = await db.trustedUser.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true },
  });
  const existingSet = new Set(existing.map((r) => r.userId));
  await db.trustedUser.deleteMany({ where: { userId: { in: userIds } } });
  resetTrustCache();
  return {
    removed: userIds.filter((id) => existingSet.has(id)),
    notFound: userIds.filter((id) => !existingSet.has(id)),
  };
}
