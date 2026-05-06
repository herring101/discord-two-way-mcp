/**
 * proxy 用の純粋ロジック群（テスト可能、I/O 副作用なし）。
 * Discord MCP child を spawn して仲介する HER-79 proxy で使う。
 */

import type { ToolDefinition } from "../mcp/tools/registry.js";

export const RESTART_TOOL_NAME = "restart_server";

export const RESTART_TOOL: ToolDefinition = {
  name: RESTART_TOOL_NAME,
  description:
    '内部の Discord MCP child process を kill → respawn → 再 initialize する。Claude 側の MCP 接続は維持される。restart 中の他 in-flight request は "server restarting" エラーで返る。',
  inputSchema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "再起動理由（任意、proxy.log に記録される）",
      },
    },
  },
};

/**
 * child の `tools/list` レスポンスに proxy 自身の tool（`restart_server`）を合算する。
 * 名前衝突した場合は proxy 側を優先（child のを除外）。
 */
export function mergeTools(
  childTools: ToolDefinition[],
  proxyTools: ToolDefinition[],
): ToolDefinition[] {
  const proxyNames = new Set(proxyTools.map((t) => t.name));
  return [...childTools.filter((t) => !proxyNames.has(t.name)), ...proxyTools];
}

/**
 * バッファに溜まった文字列から完全な行（`\n` 終端）を取り出す。
 * 残りの未完了部分は次回 chunk と結合して再パースするため remainder として返す。
 * 空行（trim 後 0 文字）は破棄する。
 */
export function extractLines(buffer: string): {
  lines: string[];
  remainder: string;
} {
  const lines: string[] = [];
  let remainder = buffer;
  let nlIdx = remainder.indexOf("\n");
  while (nlIdx !== -1) {
    const line = remainder.slice(0, nlIdx).trim();
    if (line.length > 0) lines.push(line);
    remainder = remainder.slice(nlIdx + 1);
    nlIdx = remainder.indexOf("\n");
  }
  return { lines, remainder };
}

/**
 * 指数バックオフの遅延 ms を返す。
 * attempt は 1 始まり。base = 1000ms、cap = 16000ms。
 */
export function backoffMs(attempt: number, base = 1000, cap = 16000): number {
  if (attempt <= 0) return 0;
  return Math.min(base * 2 ** (attempt - 1), cap);
}

// ============================================================
// Decision functions (state machine 入力 → 行動の分類、テスト可能)
// ============================================================

export interface JsonRpcLite {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ClientMessageState {
  restarting: boolean;
  crashGiveUp: boolean;
}

export type ClientMessageAction =
  | { kind: "intercept_restart" }
  | { kind: "forward" }
  | { kind: "fail_fast"; message: string }
  | { kind: "drop" };

/**
 * Claude → proxy に届いたメッセージ 1 件を分類する。
 * - tools/call name=restart_server → proxy 自身が処理（intercept_restart）
 * - restarting 中: request は "server restarting" で fail_fast、notification は drop
 * - crashGiveUp 中: request は "child unavailable (...)" で fail_fast、notification は drop
 * - それ以外: forward
 */
export function classifyClientMessage(
  msg: JsonRpcLite,
  state: ClientMessageState,
): ClientMessageAction {
  if (
    msg.method === "tools/call" &&
    msg.params !== null &&
    typeof msg.params === "object" &&
    (msg.params as { name?: unknown }).name === RESTART_TOOL_NAME
  ) {
    return { kind: "intercept_restart" };
  }

  const isRequest =
    msg.id !== undefined && msg.id !== null && typeof msg.method === "string";

  if (state.restarting) {
    if (isRequest) return { kind: "fail_fast", message: "server restarting" };
    return { kind: "drop" };
  }

  if (state.crashGiveUp) {
    if (isRequest) {
      return {
        kind: "fail_fast",
        message: "child unavailable (crash recovery exhausted)",
      };
    }
    return { kind: "drop" };
  }

  return { kind: "forward" };
}

/**
 * tools/list レスポンスメッセージに proxy 自身の tool を合算した新しい
 * メッセージオブジェクトを返す（イミュータブル）。
 * - result が tools 配列を持たない場合は元のメッセージをそのまま返す
 */
export function maybeInjectIntoToolsListResult(
  msg: JsonRpcLite,
  additional: ToolDefinition[],
): JsonRpcLite {
  if (msg.result === null || typeof msg.result !== "object") return msg;
  const result = msg.result as { tools?: unknown };
  if (!Array.isArray(result.tools)) return msg;
  return {
    ...msg,
    result: {
      ...result,
      tools: mergeTools(result.tools as ToolDefinition[], additional),
    },
  };
}

// ============================================================
// Crash recovery state machine
// ============================================================

export interface CrashRecoveryInput {
  currentAttempt: number;
  maxAttempts: number;
}

export type CrashRecoveryStep =
  | { kind: "respawn"; delayMs: number; nextAttempt: number }
  | { kind: "give_up" };

/**
 * 直前の attempt を入力に、次にやるべきこと (respawn or give_up) を決める。
 * - currentAttempt: これまでに失敗した回数 (0 始まり、初回 crash 時は 0)
 * - 戻り値の nextAttempt は、増分後の attempt (1 始まり)
 * - delayMs は backoffMs(nextAttempt)
 */
export function nextCrashRecoveryStep(
  input: CrashRecoveryInput,
): CrashRecoveryStep {
  const next = input.currentAttempt + 1;
  if (next > input.maxAttempts) return { kind: "give_up" };
  return { kind: "respawn", delayMs: backoffMs(next), nextAttempt: next };
}

// ============================================================
// performRestart (副作用は注入された関数に集約、テスト可能)
// ============================================================

export interface PerformRestartContext {
  oldPid?: number;
  cachedInitialize: JsonRpcLite | null;
  cachedInitialized: JsonRpcLite | null;
  /** 旧 child を SIGTERM (5s) → SIGKILL の段で確実に殺す */
  killAndWaitOldChild: () => Promise<void>;
  /** 新 child を spawn し、ready 化されたら pid を返す */
  spawnNewChild: () => Promise<{ pid: number }>;
  /** child に request を送り、id 一致の response を待つ。timeout で null */
  sendAndWait: (
    req: JsonRpcLite,
    timeoutMs: number,
  ) => Promise<JsonRpcLite | null>;
  /** 通知 (id なし) を child に送る */
  sendToChild: (msg: JsonRpcLite) => boolean;
  nextProxyId: () => string;
  /** テスト用に時刻ソースを差し替え可 */
  now?: () => number;
}

export type PerformRestartResult =
  | { ok: true; oldPid?: number; newPid: number; durationMs: number }
  | { ok: false; error: string };

/**
 * restart の主要ステップ:
 *   1. 旧 child kill 待ち
 *   2. 新 child spawn
 *   3. cachedInitialize があれば replay (15s timeout)
 *   4. cachedInitialized があれば forward
 *
 * I/O は ctx 経由で注入。純関数化はしないが、副作用は外で組み立てるので
 * timeout / sendAndWait の振舞を制御してテストできる。
 */
export async function performRestart(
  ctx: PerformRestartContext,
): Promise<PerformRestartResult> {
  const now = ctx.now ?? Date.now;
  const start = now();

  await ctx.killAndWaitOldChild();
  const newChild = await ctx.spawnNewChild();

  if (ctx.cachedInitialize) {
    const replay: JsonRpcLite = {
      ...ctx.cachedInitialize,
      id: ctx.nextProxyId(),
    };
    const initResponse = await ctx.sendAndWait(replay, 15000);
    if (!initResponse) {
      return { ok: false, error: "child initialize timeout (15s)" };
    }
    if (initResponse.error) {
      return {
        ok: false,
        error: `child initialize error: ${initResponse.error.message}`,
      };
    }
    if (ctx.cachedInitialized) {
      ctx.sendToChild(ctx.cachedInitialized);
    }
  }

  return {
    ok: true,
    oldPid: ctx.oldPid,
    newPid: newChild.pid,
    durationMs: now() - start,
  };
}
