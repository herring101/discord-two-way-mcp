/**
 * 未読管理ロジックのテスト
 */

import { describe, expect, test } from "bun:test";
import { formatUnreadSummary, type UnreadSummary } from "./unread.js";

// Note: DB操作を伴う関数のテストは統合テストで行う
// ここでは純粋関数のみをテスト

describe("formatUnreadSummary", () => {
  test("空の場合", () => {
    const result = formatUnreadSummary([]);
    expect(result).toBeNull();
  });

  test("1チャンネルの未読", () => {
    const summaries: UnreadSummary[] = [
      {
        channelId: "123456",
        guildId: "guild-1",
        unreadCount: 5,
        lastReadMessageId: null,
      },
    ];
    const result = formatUnreadSummary(summaries);
    expect(result).toContain("未読サマリー");
    expect(result).toContain("ch:123456 - 5件の未読");
  });

  test("複数チャンネルの未読", () => {
    const summaries: UnreadSummary[] = [
      {
        channelId: "123",
        guildId: "guild-1",
        unreadCount: 10,
        lastReadMessageId: null,
      },
      {
        channelId: "456",
        guildId: "guild-1",
        unreadCount: 3,
        lastReadMessageId: "msg-1",
      },
    ];
    const result = formatUnreadSummary(summaries);
    expect(result).toContain("ch:123 - 10件の未読");
    expect(result).toContain("ch:456 - 3件の未読");
  });
});
