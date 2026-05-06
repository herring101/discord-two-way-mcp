/**
 * proxy-core.ts の純粋ロジックテスト。
 */

import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "../mcp/tools/registry.js";
import {
  backoffMs,
  extractLines,
  mergeTools,
  RESTART_TOOL,
  RESTART_TOOL_NAME,
} from "./proxy-core.js";

const dummyTool = (name: string): ToolDefinition => ({
  name,
  description: `dummy ${name}`,
  inputSchema: { type: "object", properties: {} },
});

describe("RESTART_TOOL", () => {
  test("name は restart_server", () => {
    expect(RESTART_TOOL.name).toBe(RESTART_TOOL_NAME);
    expect(RESTART_TOOL_NAME).toBe("restart_server");
  });

  test("inputSchema に reason プロパティ (任意) がある", () => {
    expect(RESTART_TOOL.inputSchema.type).toBe("object");
    expect(RESTART_TOOL.inputSchema.properties.reason).toBeDefined();
    expect(RESTART_TOOL.inputSchema.required).toBeUndefined();
  });
});

describe("mergeTools", () => {
  test("child + proxy の tool 一覧を末尾に proxy を並べて返す", () => {
    const child = [dummyTool("a"), dummyTool("b")];
    const proxy = [dummyTool("restart_server")];
    const merged = mergeTools(child, proxy);
    expect(merged.map((t) => t.name)).toEqual(["a", "b", "restart_server"]);
  });

  test("名前衝突した child tool は除外、proxy 側を採用", () => {
    const child = [dummyTool("a"), dummyTool("restart_server")];
    const proxy = [dummyTool("restart_server")];
    const merged = mergeTools(child, proxy);
    expect(merged.map((t) => t.name)).toEqual(["a", "restart_server"]);
    // proxy 側の参照がそのまま採用されることを確認 (=== identity check)
    const restart = merged.find((t) => t.name === "restart_server");
    expect(restart === proxy[0]).toBe(true);
  });

  test("空配列の組合せでも壊れない", () => {
    expect(mergeTools([], [])).toEqual([]);
    expect(mergeTools([dummyTool("a")], [])).toEqual([dummyTool("a")]);
    expect(mergeTools([], [dummyTool("x")])).toEqual([dummyTool("x")]);
  });
});

describe("extractLines", () => {
  test("空文字 → 空", () => {
    expect(extractLines("")).toEqual({ lines: [], remainder: "" });
  });

  test("単一完全行", () => {
    expect(extractLines("hello\n")).toEqual({
      lines: ["hello"],
      remainder: "",
    });
  });

  test("複数行 + 末尾未完了", () => {
    const out = extractLines("a\nbb\nccc");
    expect(out.lines).toEqual(["a", "bb"]);
    expect(out.remainder).toBe("ccc");
  });

  test("空行（trim 後 0 文字）はスキップ", () => {
    const out = extractLines("a\n\nb\n   \n");
    expect(out.lines).toEqual(["a", "b"]);
    expect(out.remainder).toBe("");
  });

  test("末尾改行ありで remainder が空", () => {
    const out = extractLines("x\ny\n");
    expect(out.lines).toEqual(["x", "y"]);
    expect(out.remainder).toBe("");
  });

  test("改行なしの 1 chunk → 全部 remainder", () => {
    const out = extractLines("partial");
    expect(out.lines).toEqual([]);
    expect(out.remainder).toBe("partial");
  });
});

describe("backoffMs", () => {
  test("attempt=1 → base", () => {
    expect(backoffMs(1)).toBe(1000);
  });

  test("attempt=2,3,4 → base*2,4,8", () => {
    expect(backoffMs(2)).toBe(2000);
    expect(backoffMs(3)).toBe(4000);
    expect(backoffMs(4)).toBe(8000);
  });

  test("cap で頭打ち", () => {
    expect(backoffMs(5)).toBe(16000);
    expect(backoffMs(10)).toBe(16000);
  });

  test("attempt=0 以下 → 0", () => {
    expect(backoffMs(0)).toBe(0);
    expect(backoffMs(-1)).toBe(0);
  });
});
