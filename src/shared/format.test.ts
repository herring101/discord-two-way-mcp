/**
 * format.ts の trusted/untrusted ラップ動作テスト。
 *
 * trust 判定ロジック自体は呼び出し側責任なので、ここでは
 * msg.trusted フラグを直接渡して formatMessage の出力を検証する。
 * isTrustedUser のテストは security/trust.test.ts を参照。
 */

import { describe, expect, test } from "bun:test";
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

describe("formatMessage trust フラグ動作", () => {
  test("trusted=true は UNTRUSTED 境界が付かない", () => {
    const out = formatMessage({ ...baseMessage, trusted: true });
    expect(out).not.toContain("<UNTRUSTED_BEGIN");
    expect(out).not.toContain("<UNTRUSTED_END>");
    expect(out).toContain("hello world");
  });

  test("trusted=false は body のみが UNTRUSTED 境界で囲まれる", () => {
    const out = formatMessage({ ...baseMessage, trusted: false });
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

  test("trusted 未指定はデフォルトで untrusted (安全側) として扱う", () => {
    const out = formatMessage(baseMessage);
    expect(out).toContain("<UNTRUSTED_BEGIN");
    expect(out).toContain("<UNTRUSTED_END>");
  });

  test("trusted=false + 添付/Embed/リアクション → 全て境界内に入る", () => {
    const out = formatMessage({
      ...baseMessage,
      trusted: false,
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

  test("DM (channelName=null) trusted=false → channel 属性は付かない", () => {
    const out = formatMessage({
      ...baseMessage,
      channelName: null,
      trusted: false,
    });
    expect(out).toContain("[DM]");
    expect(out).toContain("<UNTRUSTED_BEGIN");
    expect(out).not.toContain("channel=");
    expect(out).toContain('username="alice"');
  });
});
