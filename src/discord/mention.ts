/**
 * 受信メッセージが「Bot 宛て」かどうかを判定する純関数。
 *
 * - DM は常に Bot 宛て扱い（HER-76: DM 受信通知が来ない不具合の修正）
 * - Guild では: ユーザーメンション / Bot のロールメンション / Bot へのリプライ のいずれか
 *
 * Discord 依存型を直接受け取らないので単体テスト可能。
 */

export interface MentionOrReplyContext {
  /** DM チャンネル経由なら true（Guild なら false） */
  isDM: boolean;
  botUserId: string;
  /** メッセージで mention された user ID 集合 */
  mentionedUserIds: ReadonlySet<string>;
  /** Bot 自身が持っているロール ID 集合（DM 時は空） */
  botRoleIds: ReadonlySet<string>;
  /** メッセージで mention された role ID 集合 */
  mentionedRoleIds: ReadonlySet<string>;
  /** リプライ先メッセージの author user ID（リプライでなければ null） */
  replyToUserId: string | null;
}

export function isMentionOrReplyToBot(ctx: MentionOrReplyContext): boolean {
  // HER-76: DM は常に Bot 宛て扱い（mentions/reply の有無に関わらず通知対象）
  if (ctx.isDM) return true;

  if (ctx.mentionedUserIds.has(ctx.botUserId)) return true;

  for (const roleId of ctx.mentionedRoleIds) {
    if (ctx.botRoleIds.has(roleId)) return true;
  }

  if (ctx.replyToUserId !== null && ctx.replyToUserId === ctx.botUserId) {
    return true;
  }

  return false;
}
