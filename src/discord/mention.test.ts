/**
 * mention.ts (isMentionOrReplyToBot) のテスト。
 * HER-76: DM は常に Bot 宛て扱いで通知対象になることを保証する。
 */

import { describe, expect, test } from "bun:test";
import { isMentionOrReplyToBot } from "./mention.js";

const BOT_ID = "bot-123";

function ctx(overrides: Partial<Parameters<typeof isMentionOrReplyToBot>[0]>) {
  return {
    isDM: false,
    botUserId: BOT_ID,
    mentionedUserIds: new Set<string>(),
    botRoleIds: new Set<string>(),
    mentionedRoleIds: new Set<string>(),
    replyToUserId: null,
    ...overrides,
  };
}

describe("isMentionOrReplyToBot", () => {
  test("DM は常に true（mention/reply の有無に関わらず）", () => {
    expect(isMentionOrReplyToBot(ctx({ isDM: true }))).toBe(true);
    expect(
      isMentionOrReplyToBot(
        ctx({ isDM: true, mentionedUserIds: new Set(["other"]) }),
      ),
    ).toBe(true);
  });

  test("Guild + Bot ユーザーメンション → true", () => {
    expect(
      isMentionOrReplyToBot(
        ctx({ mentionedUserIds: new Set([BOT_ID, "other"]) }),
      ),
    ).toBe(true);
  });

  test("Guild + 他人へのメンションのみ → false", () => {
    expect(
      isMentionOrReplyToBot(ctx({ mentionedUserIds: new Set(["other"]) })),
    ).toBe(false);
  });

  test("Guild + Bot ロールへのメンション → true", () => {
    expect(
      isMentionOrReplyToBot(
        ctx({
          botRoleIds: new Set(["role-A", "role-B"]),
          mentionedRoleIds: new Set(["role-B"]),
        }),
      ),
    ).toBe(true);
  });

  test("Guild + Bot が持っていないロールへのメンション → false", () => {
    expect(
      isMentionOrReplyToBot(
        ctx({
          botRoleIds: new Set(["role-A"]),
          mentionedRoleIds: new Set(["role-X"]),
        }),
      ),
    ).toBe(false);
  });

  test("Guild + Bot へのリプライ → true", () => {
    expect(isMentionOrReplyToBot(ctx({ replyToUserId: BOT_ID }))).toBe(true);
  });

  test("Guild + 他人へのリプライ → false", () => {
    expect(isMentionOrReplyToBot(ctx({ replyToUserId: "other" }))).toBe(false);
  });

  test("Guild + 何もマッチなし → false", () => {
    expect(isMentionOrReplyToBot(ctx({}))).toBe(false);
  });
});
