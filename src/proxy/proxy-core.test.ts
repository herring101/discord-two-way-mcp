/**
 * proxy-core.ts の純粋ロジック / 注入 I/O 経由テスト。
 */

import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "../mcp/tools/registry.js";
import {
  backoffMs,
  classifyClientMessage,
  extractLines,
  type JsonRpcLite,
  maybeInjectIntoToolsListResult,
  mergeTools,
  nextCrashRecoveryStep,
  performRestart,
  RESTART_TOOL,
  RESTART_TOOL_NAME,
} from "./proxy-core.js";

const dummyTool = (name: string): ToolDefinition => ({
  name,
  description: `dummy ${name}`,
  inputSchema: { type: "object", properties: {} },
});

// ============================================================
// 既存の純関数テスト
// ============================================================

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

// ============================================================
// シナリオ追加 (review feedback 対応)
// ============================================================

describe("classifyClientMessage", () => {
  const idle = { restarting: false, crashGiveUp: false };

  test("通常 request は forward", () => {
    expect(
      classifyClientMessage(
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        idle,
      ).kind,
    ).toBe("forward");
  });

  test("tools/call name=restart_server は intercept_restart", () => {
    expect(
      classifyClientMessage(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: RESTART_TOOL_NAME, arguments: { reason: "x" } },
        },
        idle,
      ).kind,
    ).toBe("intercept_restart");
  });

  test("他の tools/call は forward", () => {
    expect(
      classifyClientMessage(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "send_message", arguments: {} },
        },
        idle,
      ).kind,
    ).toBe("forward");
  });

  describe("シナリオ 1: restart 中の fail-fast", () => {
    const restarting = { restarting: true, crashGiveUp: false };

    test("request は fail_fast / 'server restarting'", () => {
      const action = classifyClientMessage(
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        restarting,
      );
      expect(action.kind).toBe("fail_fast");
      if (action.kind === "fail_fast") {
        expect(action.message).toBe("server restarting");
      }
    });

    test("notification (id なし) は drop", () => {
      const action = classifyClientMessage(
        { jsonrpc: "2.0", method: "notifications/cancelled" },
        restarting,
      );
      expect(action.kind).toBe("drop");
    });

    test("restarting 中でも restart_server は intercept (already restarting 判定は呼び出し側)", () => {
      expect(
        classifyClientMessage(
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: RESTART_TOOL_NAME },
          },
          restarting,
        ).kind,
      ).toBe("intercept_restart");
    });
  });

  describe("シナリオ 3: crashGiveUp 後", () => {
    const giveUp = { restarting: false, crashGiveUp: true };

    test("request は fail_fast / 'child unavailable (...)'", () => {
      const action = classifyClientMessage(
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        giveUp,
      );
      expect(action.kind).toBe("fail_fast");
      if (action.kind === "fail_fast") {
        expect(action.message).toContain("child unavailable");
        expect(action.message).toContain("crash recovery exhausted");
      }
    });

    test("notification は drop", () => {
      expect(
        classifyClientMessage(
          { jsonrpc: "2.0", method: "notifications/cancelled" },
          giveUp,
        ).kind,
      ).toBe("drop");
    });
  });
});

describe("シナリオ 4: tools/list 合算 (maybeInjectIntoToolsListResult)", () => {
  test("tools 配列を持つ result に proxy tool が末尾に追加される", () => {
    const childResp: JsonRpcLite = {
      jsonrpc: "2.0",
      id: 5,
      result: { tools: [dummyTool("a"), dummyTool("b")] },
    };
    const out = maybeInjectIntoToolsListResult(childResp, [RESTART_TOOL]);
    const tools = (out.result as { tools: ToolDefinition[] }).tools;
    expect(tools.map((t) => t.name)).toEqual(["a", "b", RESTART_TOOL_NAME]);
  });

  test("元のメッセージを mutate しない (immutable)", () => {
    const childResp: JsonRpcLite = {
      jsonrpc: "2.0",
      id: 5,
      result: { tools: [dummyTool("a")] },
    };
    const out = maybeInjectIntoToolsListResult(childResp, [RESTART_TOOL]);
    expect(out).not.toBe(childResp);
    expect(
      (childResp.result as { tools: ToolDefinition[] }).tools,
    ).toHaveLength(1);
  });

  test("result が tools を持たないなら元のメッセージをそのまま返す", () => {
    const noTools: JsonRpcLite = {
      jsonrpc: "2.0",
      id: 5,
      result: { other: 1 },
    };
    const out = maybeInjectIntoToolsListResult(noTools, [RESTART_TOOL]);
    expect(out).toBe(noTools);
  });

  test("result が null/非オブジェクトなら元のまま", () => {
    const errResp: JsonRpcLite = {
      jsonrpc: "2.0",
      id: 5,
      error: { code: -1, message: "x" },
    };
    expect(maybeInjectIntoToolsListResult(errResp, [RESTART_TOOL])).toBe(
      errResp,
    );
  });

  test("名前衝突した child tool は proxy 優先で dedupe される", () => {
    const childResp: JsonRpcLite = {
      jsonrpc: "2.0",
      id: 5,
      result: { tools: [dummyTool(RESTART_TOOL_NAME), dummyTool("a")] },
    };
    const out = maybeInjectIntoToolsListResult(childResp, [RESTART_TOOL]);
    const tools = (out.result as { tools: ToolDefinition[] }).tools;
    expect(tools.map((t) => t.name)).toEqual(["a", RESTART_TOOL_NAME]);
    // proxy 側の参照が末尾に居る
    expect(tools[tools.length - 1] === RESTART_TOOL).toBe(true);
  });
});

describe("シナリオ 2: crash 一連 (nextCrashRecoveryStep)", () => {
  test("初回 (currentAttempt=0) → respawn 1, 1000ms", () => {
    const step = nextCrashRecoveryStep({ currentAttempt: 0, maxAttempts: 5 });
    expect(step).toEqual({ kind: "respawn", delayMs: 1000, nextAttempt: 1 });
  });

  test("currentAttempt=1..4 → 指数バックオフ", () => {
    expect(
      nextCrashRecoveryStep({ currentAttempt: 1, maxAttempts: 5 }),
    ).toEqual({ kind: "respawn", delayMs: 2000, nextAttempt: 2 });
    expect(
      nextCrashRecoveryStep({ currentAttempt: 2, maxAttempts: 5 }),
    ).toEqual({ kind: "respawn", delayMs: 4000, nextAttempt: 3 });
    expect(
      nextCrashRecoveryStep({ currentAttempt: 3, maxAttempts: 5 }),
    ).toEqual({ kind: "respawn", delayMs: 8000, nextAttempt: 4 });
    expect(
      nextCrashRecoveryStep({ currentAttempt: 4, maxAttempts: 5 }),
    ).toEqual({ kind: "respawn", delayMs: 16000, nextAttempt: 5 });
  });

  test("currentAttempt=5 (max 到達後) → give_up", () => {
    expect(
      nextCrashRecoveryStep({ currentAttempt: 5, maxAttempts: 5 }),
    ).toEqual({ kind: "give_up" });
    expect(
      nextCrashRecoveryStep({ currentAttempt: 100, maxAttempts: 5 }),
    ).toEqual({ kind: "give_up" });
  });

  test("maxAttempts=3 のときは早めに give_up", () => {
    expect(
      nextCrashRecoveryStep({ currentAttempt: 3, maxAttempts: 3 }).kind,
    ).toBe("give_up");
  });
});

describe("シナリオ 5: performRestart (initialize replay timeout 含む)", () => {
  // 共通の最小 ctx を作る関数
  function ctx(
    overrides: Partial<Parameters<typeof performRestart>[0]> = {},
  ): Parameters<typeof performRestart>[0] {
    return {
      oldPid: 100,
      cachedInitialize: null,
      cachedInitialized: null,
      killAndWaitOldChild: async () => {},
      spawnNewChild: async () => ({ pid: 200 }),
      sendAndWait: async () => null,
      sendToChild: () => true,
      nextProxyId: () => "proxy-id-test",
      now: () => 1000,
      ...overrides,
    };
  }

  test("cachedInitialize なし → kill + spawn のみで ok:true", async () => {
    const result = await performRestart(ctx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.oldPid).toBe(100);
      expect(result.newPid).toBe(200);
      expect(result.durationMs).toBe(0);
    }
  });

  test("cachedInitialize あり + replay 成功 → ok:true、cachedInitialized も forward される", async () => {
    let forwardedInitialized = false;
    const result = await performRestart(
      ctx({
        cachedInitialize: { jsonrpc: "2.0", id: 0, method: "initialize" },
        cachedInitialized: {
          jsonrpc: "2.0",
          method: "notifications/initialized",
        },
        sendAndWait: async () => ({
          jsonrpc: "2.0",
          id: "proxy-id-test",
          result: { protocolVersion: "x" },
        }),
        sendToChild: (msg) => {
          if (msg.method === "notifications/initialized") {
            forwardedInitialized = true;
          }
          return true;
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(forwardedInitialized).toBe(true);
  });

  test("cachedInitialize あり + replay timeout (sendAndWait null) → ok:false", async () => {
    const result = await performRestart(
      ctx({
        cachedInitialize: { jsonrpc: "2.0", id: 0, method: "initialize" },
        sendAndWait: async () => null, // timeout
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("initialize timeout");
    }
  });

  test("cachedInitialize あり + replay error → ok:false で error message を含む", async () => {
    const result = await performRestart(
      ctx({
        cachedInitialize: { jsonrpc: "2.0", id: 0, method: "initialize" },
        sendAndWait: async () => ({
          jsonrpc: "2.0",
          id: "proxy-id-test",
          error: { code: -1, message: "child internal error" },
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("child internal error");
    }
  });

  test("durationMs は now() の差分で計算される", async () => {
    let nowVal = 5000;
    const result = await performRestart(
      ctx({
        now: () => {
          const v = nowVal;
          nowVal += 1234;
          return v;
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.durationMs).toBe(1234);
  });

  test("killAndWaitOldChild と spawnNewChild が順序通り呼ばれる", async () => {
    const calls: string[] = [];
    await performRestart(
      ctx({
        killAndWaitOldChild: async () => {
          calls.push("kill");
        },
        spawnNewChild: async () => {
          calls.push("spawn");
          return { pid: 200 };
        },
      }),
    );
    expect(calls).toEqual(["kill", "spawn"]);
  });
});
