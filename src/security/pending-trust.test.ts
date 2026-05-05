/**
 * pending-trust.ts の純粋ロジック (isExpired) のテスト。
 * DB 操作部 (create/find/resolve) は実機/統合テストで確認する。
 */

import { describe, expect, test } from "bun:test";
import { isExpired, type PendingTrustRequest } from "./pending-trust.js";

const baseReq: PendingTrustRequest = {
  id: "req-1",
  userIds: ["123"],
  reason: "test",
  requestedBy: "clamane",
  dmMessageId: null,
  createdAt: new Date("2026-05-05T00:00:00Z"),
  resolvedAt: null,
  resolution: null,
};

describe("isExpired", () => {
  test("作成直後は false", () => {
    expect(isExpired(baseReq, new Date("2026-05-05T00:00:00Z").getTime())).toBe(
      false,
    );
  });

  test("23h59m 経過は false", () => {
    const now = new Date("2026-05-05T23:59:00Z").getTime();
    expect(isExpired(baseReq, now)).toBe(false);
  });

  test("24h ちょうどは false (ぎりぎり)", () => {
    const now = new Date("2026-05-06T00:00:00Z").getTime();
    expect(isExpired(baseReq, now)).toBe(false);
  });

  test("24h 1ms 超は true", () => {
    const now = new Date("2026-05-06T00:00:00Z").getTime() + 1;
    expect(isExpired(baseReq, now)).toBe(true);
  });

  test("数日後は true", () => {
    const now = new Date("2026-05-08T00:00:00Z").getTime();
    expect(isExpired(baseReq, now)).toBe(true);
  });
});
