/**
 * MCP tool 入力検証バリデータ (validators.ts) のテスト。
 */

import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, test } from "bun:test";
import {
  clampNumberInRange,
  validateActionEnum,
  validateChannelOrGuild,
  validateIso8601Date,
  validateOptionalString,
  validateRequiredString,
  validateStringArray,
} from "./validators.js";

describe("validateActionEnum", () => {
  test("許可された値を返す", () => {
    expect(validateActionEnum("add", ["add", "remove"] as const)).toBe("add");
  });

  test("許可外の値で McpError", () => {
    expect(() =>
      validateActionEnum("foo", ["add", "remove"] as const),
    ).toThrow(McpError);
  });

  test("undefined で McpError", () => {
    expect(() =>
      validateActionEnum(undefined, ["add", "remove"] as const),
    ).toThrow(McpError);
  });

  test("カスタム fieldName を含むメッセージ", () => {
    try {
      validateActionEnum("x", ["a", "b"] as const, "mode");
      expect("should have thrown").toBe("but did not");
    } catch (e) {
      expect((e as McpError).message).toContain("mode");
    }
  });
});

describe("validateRequiredString", () => {
  test("非空文字列を返す", () => {
    expect(validateRequiredString("hello", "name")).toBe("hello");
  });

  test("空文字列で McpError", () => {
    expect(() => validateRequiredString("", "name")).toThrow(McpError);
  });

  test("undefined で McpError", () => {
    expect(() => validateRequiredString(undefined, "name")).toThrow(McpError);
  });

  test("数値で McpError", () => {
    expect(() => validateRequiredString(123, "name")).toThrow(McpError);
  });
});

describe("validateOptionalString", () => {
  test("undefined はそのまま undefined", () => {
    expect(validateOptionalString(undefined, "x")).toBeUndefined();
  });

  test("null も undefined", () => {
    expect(validateOptionalString(null, "x")).toBeUndefined();
  });

  test("文字列はそのまま", () => {
    expect(validateOptionalString("abc", "x")).toBe("abc");
  });

  test("数値で McpError", () => {
    expect(() => validateOptionalString(123, "x")).toThrow(McpError);
  });
});

describe("validateChannelOrGuild", () => {
  test("channelId のみで OK", () => {
    expect(validateChannelOrGuild({ channelId: "c1" })).toEqual({
      channelId: "c1",
      guildId: undefined,
    });
  });

  test("guildId のみで OK", () => {
    expect(validateChannelOrGuild({ guildId: "g1" })).toEqual({
      channelId: undefined,
      guildId: "g1",
    });
  });

  test("両方ありで OK", () => {
    expect(
      validateChannelOrGuild({ channelId: "c1", guildId: "g1" }),
    ).toEqual({ channelId: "c1", guildId: "g1" });
  });

  test("両方なしで McpError", () => {
    expect(() => validateChannelOrGuild({})).toThrow(McpError);
  });
});

describe("clampNumberInRange", () => {
  test("範囲内の数値はそのまま", () => {
    expect(clampNumberInRange(50, { min: 1, max: 100, default: 20 })).toBe(50);
  });

  test("min より小さいと min に", () => {
    expect(clampNumberInRange(0, { min: 1, max: 100, default: 20 })).toBe(1);
  });

  test("max より大きいと max に", () => {
    expect(clampNumberInRange(200, { min: 1, max: 100, default: 20 })).toBe(
      100,
    );
  });

  test("undefined は default", () => {
    expect(
      clampNumberInRange(undefined, { min: 1, max: 100, default: 20 }),
    ).toBe(20);
  });

  test("非数値は default", () => {
    expect(clampNumberInRange("foo", { min: 1, max: 100, default: 20 })).toBe(
      20,
    );
  });

  test("NaN は default", () => {
    expect(
      clampNumberInRange(Number.NaN, { min: 1, max: 100, default: 20 }),
    ).toBe(20);
  });
});

describe("validateIso8601Date", () => {
  test("正常な ISO 8601 文字列", () => {
    const d = validateIso8601Date("2026-05-06T09:00:00Z", "executeAt");
    expect(d.getUTCFullYear()).toBe(2026);
  });

  test("不正な日時文字列で McpError", () => {
    expect(() => validateIso8601Date("not-a-date", "executeAt")).toThrow(
      McpError,
    );
  });

  test("undefined で McpError", () => {
    expect(() => validateIso8601Date(undefined, "executeAt")).toThrow(
      McpError,
    );
  });
});

describe("validateStringArray", () => {
  test("配列の各要素をそのまま返す", () => {
    expect(validateStringArray(["a", "b", "c"], "ids")).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("配列でないと McpError", () => {
    expect(() => validateStringArray("abc", "ids")).toThrow(McpError);
  });

  test("要素が空文字列で McpError", () => {
    expect(() => validateStringArray(["a", ""], "ids")).toThrow(McpError);
  });

  test("要素が非文字列で McpError", () => {
    expect(() => validateStringArray(["a", 123], "ids")).toThrow(McpError);
  });
});
