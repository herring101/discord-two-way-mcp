/**
 * proxy-core.ts の純粋ロジック / 注入 I/O 経由テスト。
 */

import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "../mcp/tools/registry.js";
import {
  backoffMs,
  buildSyntheticInitializeResponse,
  buildSyntheticToolsListResponse,
  classifyClientMessage,
  extractLines,
  type JsonRpcLite,
  mergeTools,
  nextCrashRecoveryStep,
  PROXY_PROTOCOL_VERSION,
  PROXY_SERVER_INFO,
  performRestart,
  RESTART_TOOL,
  RESTART_TOOL_NAME,
  replayInitialize,
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
    expect(mergeTools(child, proxy).map((t) => t.name)).toEqual([
      "a",
      "b",
      "restart_server",
    ]);
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

  test("空行はスキップ", () => {
    expect(extractLines("a\n\nb\n   \n").lines).toEqual(["a", "b"]);
  });

  test("末尾改行ありで remainder 空", () => {
    expect(extractLines("x\ny\n").remainder).toBe("");
  });

  test("改行なしの 1 chunk → 全部 remainder", () => {
    expect(extractLines("partial").remainder).toBe("partial");
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
// classifyClientMessage (新 state machine)
// ============================================================

describe("classifyClientMessage", () => {
  const idle = { restarting: false, proxyState: "idle" as const };
  const initRecv = {
    restarting: false,
    proxyState: "initialize_received" as const,
  };
  const clientInit = {
    restarting: false,
    proxyState: "client_initialized" as const,
  };
  const running = { restarting: false, proxyState: "running" as const };
  const giveUp = { restarting: false, proxyState: "give_up" as const };
  const restarting = { restarting: true, proxyState: "running" as const };

  const allStates = [idle, initRecv, clientInit, running, giveUp, restarting];

  test("initialize は intercept_initialize (全 state で)", () => {
    for (const state of allStates) {
      expect(
        classifyClientMessage(
          { jsonrpc: "2.0", id: 1, method: "initialize" },
          state,
        ).kind,
      ).toBe("intercept_initialize");
    }
  });

  test("notifications/initialized は cache_initialized (全 state で)", () => {
    for (const state of allStates) {
      expect(
        classifyClientMessage(
          { jsonrpc: "2.0", method: "notifications/initialized" },
          state,
        ).kind,
      ).toBe("cache_initialized");
    }
  });

  test("tools/list は synthetic_tools_list (全 state で)", () => {
    for (const state of allStates) {
      expect(
        classifyClientMessage(
          { jsonrpc: "2.0", id: 2, method: "tools/list" },
          state,
        ).kind,
      ).toBe("synthetic_tools_list");
    }
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
        running,
      ).kind,
    ).toBe("intercept_restart");
  });

  test("running 中の通常 tools/call は forward", () => {
    expect(
      classifyClientMessage(
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "send_message", arguments: {} },
        },
        running,
      ).kind,
    ).toBe("forward");
  });

  describe("シナリオ 1: restart 中の fail-fast", () => {
    test("通常 request は fail_fast 'server restarting'", () => {
      const action = classifyClientMessage(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "send_message" },
        },
        restarting,
      );
      expect(action.kind).toBe("fail_fast");
      if (action.kind === "fail_fast") {
        expect(action.message).toBe("server restarting");
      }
    });
    test("notification は drop", () => {
      expect(
        classifyClientMessage(
          { jsonrpc: "2.0", method: "notifications/cancelled" },
          restarting,
        ).kind,
      ).toBe("drop");
    });
  });

  describe("シナリオ 3: proxyState=give_up", () => {
    test("通常 request は fail_fast 'child unavailable (...)'", () => {
      const action = classifyClientMessage(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "send_message" },
        },
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

  describe("非 running state は通常 request を fail_fast", () => {
    const nonRunning = [
      ["idle", idle],
      ["initialize_received", initRecv],
      ["client_initialized", clientInit],
    ] as const;

    for (const [label, state] of nonRunning) {
      test(`${label}: tools/call は 'server starting, please retry'`, () => {
        const action = classifyClientMessage(
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "send_message" },
          },
          state,
        );
        expect(action.kind).toBe("fail_fast");
        if (action.kind === "fail_fast") {
          expect(action.message).toContain("server starting");
        }
      });
      test(`${label}: notification は drop`, () => {
        expect(
          classifyClientMessage(
            { jsonrpc: "2.0", method: "notifications/cancelled" },
            state,
          ).kind,
        ).toBe("drop");
      });
    }
  });

  describe("Phase 1-C: client_initialized 前は forward 不可 (notifications/tools/list_changed が出ない事の前提)", () => {
    test("idle / initialize_received は通常 request を forward しない", () => {
      for (const state of [idle, initRecv]) {
        const action = classifyClientMessage(
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "send_message" },
          },
          state,
        );
        expect(action.kind).not.toBe("forward");
      }
    });
    test("client_initialized でも未だ forward しない (running 待ち)", () => {
      const action = classifyClientMessage(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "send_message" },
        },
        clientInit,
      );
      expect(action.kind).not.toBe("forward");
    });
    test("running になって初めて forward", () => {
      const action = classifyClientMessage(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "send_message" },
        },
        running,
      );
      expect(action.kind).toBe("forward");
    });
  });
});

// ============================================================
// Synthetic responses (HER-79 修正の核)
// ============================================================

describe("buildSyntheticInitializeResponse", () => {
  test("client の id と protocolVersion を echo した response を返す", () => {
    const req: JsonRpcLite = {
      jsonrpc: "2.0",
      id: 7,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        clientInfo: { name: "test", version: "1.0" },
        capabilities: {},
      },
    };
    const resp = buildSyntheticInitializeResponse(req);
    expect(resp.jsonrpc).toBe("2.0");
    expect(resp.id).toBe(7);
    const result = resp.result as {
      protocolVersion: string;
      serverInfo: { name: string };
      capabilities: { tools: { listChanged: boolean } };
    };
    expect(result.protocolVersion).toBe("2025-03-26");
    expect(result.serverInfo.name).toBe(PROXY_SERVER_INFO.name);
    expect(result.capabilities.tools.listChanged).toBe(true);
  });

  test("protocolVersion 欠損時はデフォルトを使う", () => {
    const req: JsonRpcLite = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    };
    const resp = buildSyntheticInitializeResponse(req);
    expect((resp.result as { protocolVersion: string }).protocolVersion).toBe(
      PROXY_PROTOCOL_VERSION,
    );
  });

  test("id 欠損時は null を入れる", () => {
    const resp = buildSyntheticInitializeResponse({
      jsonrpc: "2.0",
      method: "initialize",
    });
    expect(resp.id).toBeNull();
  });
});

describe("buildSyntheticToolsListResponse (Option B 含む)", () => {
  const req: JsonRpcLite = { jsonrpc: "2.0", id: 9, method: "tools/list" };

  test("cache あり → cached + proxyTools の merge", () => {
    const resp = buildSyntheticToolsListResponse(
      req,
      [dummyTool("a"), dummyTool("b")],
      [RESTART_TOOL],
    );
    const tools = (resp.result as { tools: ToolDefinition[] }).tools;
    expect(tools.map((t) => t.name)).toEqual(["a", "b", RESTART_TOOL_NAME]);
    expect(resp.id).toBe(9);
  });

  test("cache なし (Option B: child not ready) → proxyTools のみ", () => {
    const resp = buildSyntheticToolsListResponse(req, null, [RESTART_TOOL]);
    const tools = (resp.result as { tools: ToolDefinition[] }).tools;
    expect(tools.map((t) => t.name)).toEqual([RESTART_TOOL_NAME]);
  });

  test("cache 内に衝突 tool あり → proxy 優先で dedupe", () => {
    const resp = buildSyntheticToolsListResponse(
      req,
      [dummyTool(RESTART_TOOL_NAME), dummyTool("a")],
      [RESTART_TOOL],
    );
    const tools = (resp.result as { tools: ToolDefinition[] }).tools;
    expect(tools.map((t) => t.name)).toEqual(["a", RESTART_TOOL_NAME]);
    expect(tools[tools.length - 1] === RESTART_TOOL).toBe(true);
  });

  test("id 欠損時は null を入れる", () => {
    const resp = buildSyntheticToolsListResponse(
      { jsonrpc: "2.0", method: "tools/list" },
      null,
      [RESTART_TOOL],
    );
    expect(resp.id).toBeNull();
  });
});

// ============================================================
// Crash recovery state machine
// ============================================================

describe("シナリオ 2: crash 一連 (nextCrashRecoveryStep)", () => {
  test("初回 (currentAttempt=0) → respawn 1, 1000ms", () => {
    expect(
      nextCrashRecoveryStep({ currentAttempt: 0, maxAttempts: 5 }),
    ).toEqual({ kind: "respawn", delayMs: 1000, nextAttempt: 1 });
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
  });
});

// ============================================================
// replayInitialize (initialize replay timeout / error / skipped)
// ============================================================

describe("replayInitialize (旧 シナリオ 5: initialize replay timeout 含む)", () => {
  function ctx(
    overrides: Partial<Parameters<typeof replayInitialize>[0]> = {},
  ): Parameters<typeof replayInitialize>[0] {
    return {
      cachedInitialize: { jsonrpc: "2.0", id: 0, method: "initialize" },
      cachedInitialized: null,
      sendAndWait: async () => null,
      sendToChild: () => true,
      nextProxyId: () => "proxy-id-test",
      timeoutMs: 100,
      ...overrides,
    };
  }

  test("cachedInitialize なし → skipped", async () => {
    expect((await replayInitialize(ctx({ cachedInitialize: null }))).kind).toBe(
      "skipped",
    );
  });

  test("成功 + cachedInitialized 送信", async () => {
    let initializedSent = false;
    const result = await replayInitialize(
      ctx({
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
            initializedSent = true;
          }
          return true;
        },
      }),
    );
    expect(result.kind).toBe("ok");
    expect(initializedSent).toBe(true);
  });

  test("timeout (sendAndWait null) → error", async () => {
    const result = await replayInitialize(
      ctx({ sendAndWait: async () => null }),
    );
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.error).toContain("timeout");
    }
  });

  test("error response → error message を含む", async () => {
    const result = await replayInitialize(
      ctx({
        sendAndWait: async () => ({
          jsonrpc: "2.0",
          id: "proxy-id-test",
          error: { code: -1, message: "child internal error" },
        }),
      }),
    );
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.error).toContain("child internal error");
    }
  });

  test("nextProxyId が呼ばれて id が differ する", async () => {
    let captured: JsonRpcLite | null = null;
    await replayInitialize(
      ctx({
        cachedInitialize: { jsonrpc: "2.0", id: 0, method: "initialize" },
        sendAndWait: async (req) => {
          captured = req;
          return {
            jsonrpc: "2.0",
            id: req.id ?? null,
            result: { protocolVersion: "x" },
          };
        },
        nextProxyId: () => "fresh-proxy-id",
      }),
    );
    expect(captured).not.toBeNull();
    expect((captured as JsonRpcLite | null)?.id).toBe("fresh-proxy-id");
  });
});

// ============================================================
// performRestart (kill + spawn のみに簡素化された後の挙動)
// ============================================================

describe("performRestart (kill + spawn only)", () => {
  function ctx(
    overrides: Partial<Parameters<typeof performRestart>[0]> = {},
  ): Parameters<typeof performRestart>[0] {
    return {
      oldPid: 100,
      killAndWaitOldChild: async () => {},
      spawnNewChild: async () => ({ pid: 200 }),
      now: () => 1000,
      ...overrides,
    };
  }

  test("成功 → ok:true / oldPid / newPid / durationMs", async () => {
    const result = await performRestart(ctx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.oldPid).toBe(100);
      expect(result.newPid).toBe(200);
      expect(result.durationMs).toBe(0);
    }
  });

  test("kill が throw → ok:false", async () => {
    const result = await performRestart(
      ctx({
        killAndWaitOldChild: async () => {
          throw new Error("kill failed");
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("kill failed");
  });

  test("spawn が throw → ok:false", async () => {
    const result = await performRestart(
      ctx({
        spawnNewChild: async () => {
          throw new Error("spawn failed");
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("spawn failed");
  });

  test("kill → spawn の順序", async () => {
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

  test("durationMs は now() の差分", async () => {
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
});
