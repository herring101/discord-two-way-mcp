/**
 * Owner (本人) 設定の取得・更新。
 *
 * 起点: env NOTIFY_TARGET_USER_ID
 * 永続化: OwnerConfig テーブル（singleton）
 *
 * 起動時に upsert で env 値を反映し、以降は DB の値を正とする。
 * resolveOwnerDM() が解決した DM channel ID もここでキャッシュする。
 */

import { getPrismaClient } from "../db/client.js";

const OWNER_CONFIG_ID = "singleton";

export interface OwnerConfig {
  ownerUserId: string;
  dmChannelId: string | null;
}

/**
 * env NOTIFY_TARGET_USER_ID を読む。未設定なら throw。
 */
function readOwnerUserIdFromEnv(): string {
  const value = process.env.NOTIFY_TARGET_USER_ID?.trim();
  if (!value) {
    throw new Error(
      "NOTIFY_TARGET_USER_ID 環境変数が未設定です。本人 (owner) の Discord User ID を設定してください。",
    );
  }
  return value;
}

/**
 * Owner 設定を DB から取得する。なければ env から作成して返す。
 *
 * 副作用: env 起点で初回 upsert する場合、DB に書き込む。
 */
export async function getOwnerConfig(): Promise<OwnerConfig> {
  const db = getPrismaClient();
  const existing = await db.ownerConfig.findUnique({
    where: { id: OWNER_CONFIG_ID },
  });
  if (existing) {
    return {
      ownerUserId: existing.ownerUserId,
      dmChannelId: existing.dmChannelId,
    };
  }

  const ownerUserId = readOwnerUserIdFromEnv();
  const created = await db.ownerConfig.create({
    data: { id: OWNER_CONFIG_ID, ownerUserId },
  });
  return {
    ownerUserId: created.ownerUserId,
    dmChannelId: created.dmChannelId,
  };
}

/**
 * 解決した DM Channel ID をキャッシュする。
 */
export async function setOwnerDmChannelId(dmChannelId: string): Promise<void> {
  const db = getPrismaClient();
  await db.ownerConfig.update({
    where: { id: OWNER_CONFIG_ID },
    data: { dmChannelId },
  });
}

/**
 * キャッシュした DM Channel ID を破棄する（resolve 失敗時のリカバリ）。
 */
export async function clearOwnerDmChannelId(): Promise<void> {
  const db = getPrismaClient();
  await db.ownerConfig.update({
    where: { id: OWNER_CONFIG_ID },
    data: { dmChannelId: null },
  });
}
