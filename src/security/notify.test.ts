/**
 * notify.ts の純粋ロジックのテスト。
 */

import { describe, expect, test } from "bun:test";
import {
  buildNotificationEmbeds,
  EMBED_CHUNK_LIMIT,
  parseSeverity,
  SEVERITY_COLOR,
  splitMessage,
} from "./notify.js";

describe("parseSeverity", () => {
  test("undefined → info", () => {
    expect(parseSeverity(undefined)).toBe("info");
  });

  test("有効な値はそのまま返す", () => {
    expect(parseSeverity("info")).toBe("info");
    expect(parseSeverity("warn")).toBe("warn");
    expect(parseSeverity("threat")).toBe("threat");
  });

  test("不正な値は throw", () => {
    expect(() => parseSeverity("critical")).toThrow();
    expect(() => parseSeverity(123)).toThrow();
  });
});

describe("splitMessage", () => {
  test("空文字は空配列", () => {
    expect(splitMessage("", 100)).toEqual([]);
  });

  test("maxLen 以下は 1 件", () => {
    expect(splitMessage("hello", 100)).toEqual(["hello"]);
  });

  test("maxLen 境界で分割（合計が一致する）", () => {
    const body = "a".repeat(2500);
    const chunks = splitMessage(body, 1000);
    expect(chunks.length).toBe(3);
    expect(chunks[0]?.length).toBe(1000);
    expect(chunks[1]?.length).toBe(1000);
    expect(chunks[2]?.length).toBe(500);
    expect(chunks.join("")).toBe(body);
  });

  test("maxLen=0 以下は throw", () => {
    expect(() => splitMessage("x", 0)).toThrow();
    expect(() => splitMessage("x", -1)).toThrow();
  });
});

describe("buildNotificationEmbeds", () => {
  test("info, 短文 → 単一 Embed・blue・footer 付き", () => {
    const embeds = buildNotificationEmbeds({
      message: "hello world",
      severity: "info",
    });
    expect(embeds).toHaveLength(1);
    expect(embeds[0]?.color).toBe(SEVERITY_COLOR.info);
    expect(embeds[0]?.description).toBe("hello world");
    expect(embeds[0]?.title).toContain("INFO");
    expect(embeds[0]?.footer).toBeDefined();
  });

  test("threat + category → 赤・category がタイトルに含まれる", () => {
    const embeds = buildNotificationEmbeds({
      message: "怪しい入力を検知",
      severity: "threat",
      category: "injection_suspect",
    });
    expect(embeds[0]?.color).toBe(SEVERITY_COLOR.threat);
    expect(embeds[0]?.title).toContain("THREAT");
    expect(embeds[0]?.title).toContain("injection_suspect");
  });

  test("warn → yellow", () => {
    const embeds = buildNotificationEmbeds({
      message: "注意",
      severity: "warn",
    });
    expect(embeds[0]?.color).toBe(SEVERITY_COLOR.warn);
    expect(embeds[0]?.title).toContain("WARN");
  });

  test("EMBED_CHUNK_LIMIT 超え → 分割・各 Embed に (n/N) 表示・footer は最後のみ", () => {
    const body = "a".repeat(EMBED_CHUNK_LIMIT * 2 + 100);
    const embeds = buildNotificationEmbeds({
      message: body,
      severity: "info",
    });
    expect(embeds.length).toBe(3);
    expect(embeds[0]?.title).toContain("(1/3)");
    expect(embeds[1]?.title).toContain("(2/3)");
    expect(embeds[2]?.title).toContain("(3/3)");
    expect(embeds[0]?.footer).toBeUndefined();
    expect(embeds[1]?.footer).toBeUndefined();
    expect(embeds[2]?.footer).toBeDefined();
    expect(embeds.map((e) => e.description).join("")).toBe(body);
  });

  test("空メッセージは throw", () => {
    expect(() =>
      buildNotificationEmbeds({ message: "", severity: "info" }),
    ).toThrow();
  });
});
