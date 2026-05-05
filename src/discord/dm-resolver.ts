/**
 * Owner の DMChannel を解決する。
 *
 * 1. OwnerConfig.dmChannelId キャッシュがあれば client.channels.fetch で取得
 * 2. なければ users.fetch(ownerUserId).createDM() で生成し、結果を DB にキャッシュ
 * 3. キャッシュが無効化されている場合（user 側が DM を削除など）は再生成
 *
 * DM 拒否ユーザーには createDM が rejecting する場合がある。
 * 呼び出し側で catch して適切な結果を返すこと（プロセスは落とさない）。
 */

import { type Client, DMChannel } from "discord.js";
import {
  clearOwnerDmChannelId,
  getOwnerConfig,
  setOwnerDmChannelId,
} from "../security/config.js";

export class DmDeliveryError extends Error {
  override readonly cause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "DmDeliveryError";
    this.cause = cause;
  }
}

/**
 * Owner の DMChannel を返す。失敗時は DmDeliveryError を throw する。
 */
export async function resolveOwnerDM(client: Client): Promise<DMChannel> {
  const config = await getOwnerConfig();

  if (config.dmChannelId) {
    try {
      const cached = await client.channels.fetch(config.dmChannelId);
      if (cached instanceof DMChannel) {
        return cached;
      }
      // 形が変わっている → キャッシュを破棄して再生成
      await clearOwnerDmChannelId();
    } catch {
      await clearOwnerDmChannelId();
    }
  }

  let dm: DMChannel;
  try {
    const user = await client.users.fetch(config.ownerUserId);
    dm = await user.createDM();
  } catch (error) {
    throw new DmDeliveryError(
      `Owner (${config.ownerUserId}) の DMChannel を作成できませんでした。DM 拒否設定の可能性があります。`,
      error,
    );
  }

  await setOwnerDmChannelId(dm.id);
  return dm;
}
