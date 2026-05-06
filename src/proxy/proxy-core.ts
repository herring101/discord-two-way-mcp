/**
 * proxy 用の純粋ロジック群（テスト可能、I/O 副作用なし）。
 * Discord MCP child を spawn して仲介する HER-79 proxy で使う。
 */

import type { ToolDefinition } from "../mcp/tools/registry.js";

export const RESTART_TOOL_NAME = "restart_server";
export const PROXY_PROTOCOL_VERSION = "2025-03-26";
export const PROXY_SERVER_INFO = {
  name: "discord-mcp-proxy",
  version: "1.0.0",
};

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
 * tools/list 用に child の tools 配列に proxy 自身の tool を合算する。
 * proxy は cache した tools 配列に対してこれを使う (proxy 自前で synthetic
 * tools/list を組み立てる際の merge ヘルパー)。名前衝突したら proxy 側を採用。
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

/**
 * MCP lifecycle に沿った proxy の状態。
 *
 * 進行: idle → initialize_received → client_initialized → running
 *       (失敗系: → give_up)
 *
 * - idle: proxy 起動直後、client から initialize がまだ来ていない
 * - initialize_received: client.initialize に対して synthetic response 送信済。
 *   client の notifications/initialized を待っている (それまでは
 *   server-initiated request/notification は spec 上禁止)
 * - client_initialized: client.notifications/initialized を受信。
 *   child の init replay を kick off できる
 * - running: child の init replay 完了 + tools/list cache 済 +
 *   notifications/tools/list_changed を送信済の通常運転状態
 * - give_up: child crash 5 回失敗で諦め
 */
export type ProxyState =
  | "idle"
  | "initialize_received"
  | "client_initialized"
  | "running"
  | "give_up";

export interface ClientMessageState {
  restarting: boolean;
  proxyState: ProxyState;
}

export type ClientMessageAction =
  /** proxy 自前で synthetic initialize response を返し、child 初期化を kick off */
  | { kind: "intercept_initialize" }
  /** notifications/initialized を cache、ready なら forward */
  | { kind: "cache_initialized" }
  /** proxy 自前で cached tools list (or [RESTART_TOOL] のみ) を即返却 */
  | { kind: "synthetic_tools_list" }
  /** restart_server tool 呼び出しを proxy 自身で処理 */
  | { kind: "intercept_restart" }
  /** child へ素通り forward (state=ready 前提) */
  | { kind: "forward" }
  /** request に対して error response を即返却 */
  | { kind: "fail_fast"; message: string }
  /** notification を drop */
  | { kind: "drop" };

/**
 * Claude → proxy に届いたメッセージ 1 件を分類する。
 *
 * 分岐優先順位:
 *  1. initialize → intercept_initialize (synthetic response、child 待たない)
 *  2. notifications/initialized → cache_initialized
 *  3. tools/list → synthetic_tools_list (cached + [RESTART_TOOL])
 *  4. tools/call name=restart_server → intercept_restart
 *  5. restarting 中: request fail_fast、notification drop
 *  6. proxyState=give_up: request fail_fast、notification drop
 *  7. proxyState !== running: request fail_fast (server starting)、notification drop
 *  8. それ以外 (running && !restarting): forward
 */
export function classifyClientMessage(
  msg: JsonRpcLite,
  state: ClientMessageState,
): ClientMessageAction {
  if (msg.method === "initialize") {
    return { kind: "intercept_initialize" };
  }
  if (msg.method === "notifications/initialized") {
    return { kind: "cache_initialized" };
  }
  if (msg.method === "tools/list") {
    return { kind: "synthetic_tools_list" };
  }
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

  if (state.proxyState === "give_up") {
    if (isRequest) {
      return {
        kind: "fail_fast",
        message: "child unavailable (crash recovery exhausted)",
      };
    }
    return { kind: "drop" };
  }

  if (state.proxyState !== "running") {
    if (isRequest) {
      return {
        kind: "fail_fast",
        message: "server starting, please retry",
      };
    }
    return { kind: "drop" };
  }

  return { kind: "forward" };
}

/**
 * proxy 自前の synthetic initialize response を組み立てる。
 * client から送られた `initialize` request の `id` と `protocolVersion` をエコーする。
 */
export function buildSyntheticInitializeResponse(
  req: JsonRpcLite,
): JsonRpcLite {
  const params = (req.params ?? {}) as { protocolVersion?: unknown };
  const protocolVersion =
    typeof params.protocolVersion === "string"
      ? params.protocolVersion
      : PROXY_PROTOCOL_VERSION;
  return {
    jsonrpc: "2.0",
    id: req.id ?? null,
    result: {
      protocolVersion,
      serverInfo: { ...PROXY_SERVER_INFO },
      capabilities: { tools: { listChanged: true } },
    },
  };
}

/**
 * proxy 自前の synthetic tools/list response を組み立てる。
 * cachedTools が null なら proxy tool のみを返す（child not ready / restart 中）。
 */
export function buildSyntheticToolsListResponse(
  req: JsonRpcLite,
  cachedTools: ToolDefinition[] | null,
  proxyTools: ToolDefinition[],
): JsonRpcLite {
  const tools = cachedTools
    ? mergeTools(cachedTools, proxyTools)
    : [...proxyTools];
  return {
    jsonrpc: "2.0",
    id: req.id ?? null,
    result: { tools },
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
// replayInitialize (proxy ↔ child 間の初期化、副作用は注入)
// ============================================================

export interface ReplayInitializeContext {
  cachedInitialize: JsonRpcLite | null;
  cachedInitialized: JsonRpcLite | null;
  /** child に request を送り、id 一致の response を待つ。timeout で null */
  sendAndWait: (
    req: JsonRpcLite,
    timeoutMs: number,
  ) => Promise<JsonRpcLite | null>;
  /** 通知 (id なし) を child に送る */
  sendToChild: (msg: JsonRpcLite) => boolean;
  nextProxyId: () => string;
  /** initialize response 待ち timeout (ms)、デフォルト 30s */
  timeoutMs?: number;
}

export type ReplayInitializeResult =
  | { kind: "ok" }
  | { kind: "skipped" } // cachedInitialize なし（client がまだ initialize 送ってない）
  | { kind: "error"; error: string };

/**
 * proxy が保持している initialize / initialized を child に再送する。
 * - 通常 restart や crash recovery の後で呼ぶ
 * - cachedInitialize が無い場合は skipped を返す（呼び出し側が判断）
 */
export async function replayInitialize(
  ctx: ReplayInitializeContext,
): Promise<ReplayInitializeResult> {
  if (!ctx.cachedInitialize) return { kind: "skipped" };
  const replayId = ctx.nextProxyId();
  const replay: JsonRpcLite = { ...ctx.cachedInitialize, id: replayId };
  const response = await ctx.sendAndWait(replay, ctx.timeoutMs ?? 30000);
  if (!response) {
    return { kind: "error", error: "child initialize timeout" };
  }
  if (response.error) {
    return {
      kind: "error",
      error: `child initialize error: ${response.error.message}`,
    };
  }
  if (ctx.cachedInitialized) {
    ctx.sendToChild(ctx.cachedInitialized);
  }
  return { kind: "ok" };
}

// ============================================================
// performRestart (kill + spawn のみに簡素化、initialize replay は呼び出し側で別途)
// ============================================================

export interface PerformRestartContext {
  oldPid?: number;
  killAndWaitOldChild: () => Promise<void>;
  spawnNewChild: () => Promise<{ pid: number }>;
  now?: () => number;
}

export type PerformRestartResult =
  | { ok: true; oldPid?: number; newPid: number; durationMs: number }
  | { ok: false; error: string };

/**
 * restart の kill + spawn ステップ。initialize replay は呼び出し側で
 * `replayInitialize` を別途呼ぶ。例外は ok:false に丸める。
 */
export async function performRestart(
  ctx: PerformRestartContext,
): Promise<PerformRestartResult> {
  const now = ctx.now ?? Date.now;
  const start = now();
  try {
    await ctx.killAndWaitOldChild();
    const newChild = await ctx.spawnNewChild();
    return {
      ok: true,
      oldPid: ctx.oldPid,
      newPid: newChild.pid,
      durationMs: now() - start,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
