/**
 * trust.ts のテスト。
 * DB に依存しない範囲（env パース + キャッシュ動作）に絞る。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  isTrustedUser,
  parseTrustedUserIdsFromEnv,
  resetTrustCache,
} from "./trust.js";

describe("parseTrustedUserIdsFromEnv", () => {
  test("undefined → 空配列", () => {
    expect(parseTrustedUserIdsFromEnv(undefined)).toEqual([]);
  });

  test("空文字列 → 空配列", () => {
    expect(parseTrustedUserIdsFromEnv("")).toEqual([]);
  });

  test("単一 ID", () => {
    expect(parseTrustedUserIdsFromEnv("123")).toEqual(["123"]);
  });

  test("複数 ID（trim、空要素除外）", () => {
    expect(parseTrustedUserIdsFromEnv("123, 456 ,,789")).toEqual([
      "123",
      "456",
      "789",
    ]);
  });
});

describe("isTrustedUser (env のみ、DB なし)", () => {
  const original = process.env.INITIAL_TRUSTED_USER_IDS;

  beforeEach(() => {
    resetTrustCache();
  });
  afterEach(() => {
    if (original === undefined) delete process.env.INITIAL_TRUSTED_USER_IDS;
    else process.env.INITIAL_TRUSTED_USER_IDS = original;
    resetTrustCache();
  });

  test("env 未設定 → 任意 ID は false", async () => {
    delete process.env.INITIAL_TRUSTED_USER_IDS;
    expect(await isTrustedUser("123")).toBe(false);
  });

  test("env=123 → 123 は true、他は false", async () => {
    process.env.INITIAL_TRUSTED_USER_IDS = "123";
    expect(await isTrustedUser("123")).toBe(true);
    expect(await isTrustedUser("456")).toBe(false);
  });

  test("env=複数 → 全て true", async () => {
    process.env.INITIAL_TRUSTED_USER_IDS = "111,222,333";
    expect(await isTrustedUser("111")).toBe(true);
    expect(await isTrustedUser("222")).toBe(true);
    expect(await isTrustedUser("333")).toBe(true);
    expect(await isTrustedUser("999")).toBe(false);
  });

  test("resetTrustCache 後に env 変更が反映される", async () => {
    process.env.INITIAL_TRUSTED_USER_IDS = "111";
    expect(await isTrustedUser("111")).toBe(true);
    expect(await isTrustedUser("222")).toBe(false);

    process.env.INITIAL_TRUSTED_USER_IDS = "222";
    // キャッシュ未破棄: 古いセットのまま
    expect(await isTrustedUser("222")).toBe(false);

    resetTrustCache();
    expect(await isTrustedUser("222")).toBe(true);
    expect(await isTrustedUser("111")).toBe(false);
  });
});
