/**
 * format.ts の trusted/untrusted ラップ動作テスト。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTrustCache } from "../security/trust.js";
import { type FormattableMessage, formatMessage } from "./format.js";

const baseMessage: FormattableMessage = {
  id: "msg-1",
  channelId: "ch-1",
  channelName: "general",
  author: {
    id: "user-untrusted",
    username: "alice",
    displayName: "Alice",
  },
  content: "hello world",
  timestamp: new Date("2026-05-05T12:34:00Z"),
};

describe("formatMessage trust 判定", () => {
  const original = process.env.INITIAL_TRUSTED_USER_IDS;

  beforeEach(() => {
    resetTrustCache();
  });
  afterEach(() => {
    if (original === undefined) delete process.env.INITIAL_TRUSTED_USER_IDS;
    else process.env.INITIAL_TRUSTED_USER_IDS = original;
    resetTrustCache();
  });

  test("trusted ユーザーは UNTRUSTED 境界が付かない（現状動作維持）", async () => {
    process.env.INITIAL_TRUSTED_USER_IDS = "user-untrusted";
    const out = await formatMessage(baseMessage);
    expect(out).not.toContain("<UNTRUSTED_BEGIN");
    expect(out).not.toContain("<UNTRUSTED_END>");
    expect(out).toContain("hello world");
  });

  test("untrusted ユーザーは body のみが UNTRUSTED 境界で囲まれる", async () => {
    delete process.env.INITIAL_TRUSTED_USER_IDS;
    const out = await formatMessage(baseMessage);
    expect(out).toContain(
      '<UNTRUSTED_BEGIN source="discord:user:user-untrusted"',
    );
    expect(out).toContain('username="alice"');
    expect(out).toContain('channel="general"');
    expect(out).toContain("<UNTRUSTED_END>");
    expect(out).toContain("hello world");
    // ヘッダー（チャンネル/ユーザー/時刻）は素のまま、UNTRUSTED 境界の外
    const beginIdx = out.indexOf("<UNTRUSTED_BEGIN");
    const headerIdx = out.indexOf("[#general (ch:ch-1)]");
    expect(headerIdx).toBeLessThan(beginIdx);
  });

  test("untrusted + 添付/Embed/リアクション → 全て境界内に入る", async () => {
    delete process.env.INITIAL_TRUSTED_USER_IDS;
    const out = await formatMessage({
      ...baseMessage,
      attachments: [{ filename: "a.png", parsedContent: "猫の画像" }],
      embeds: [{ title: "リンク先", description: "説明" }],
      reactions: [{ emoji: "👍", count: 2 }],
    });
    const beginIdx = out.indexOf("<UNTRUSTED_BEGIN");
    const endIdx = out.indexOf("<UNTRUSTED_END>");
    const inner = out.slice(beginIdx, endIdx);
    expect(inner).toContain("hello world");
    expect(inner).toContain("===添付ファイル===");
    expect(inner).toContain("猫の画像");
    expect(inner).toContain("===Embed===");
    expect(inner).toContain("リンク先");
    expect(inner).toContain("[👍 2]");
  });

  test("DM (channelName=null) → channel 属性は付かない", async () => {
    delete process.env.INITIAL_TRUSTED_USER_IDS;
    const out = await formatMessage({ ...baseMessage, channelName: null });
    expect(out).toContain("[DM]");
    expect(out).toContain("<UNTRUSTED_BEGIN");
    expect(out).not.toContain("channel=");
    expect(out).toContain('username="alice"');
  });
});
