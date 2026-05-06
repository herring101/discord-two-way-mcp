/**
 * Discord MCP self-hosting proxy (HER-79).
 *
 * Claude Code から見た MCP server はこの proxy。proxy が内部で本体の
 * Discord MCP server (`src/index.ts`) を child process として spawn し、
 * Claude ↔ proxy ↔ child の stdio 仲介を行う。
 *
 * 起動シーケンス (実機検証 5/6 で発覚した initialize timeout 修正後):
 *   1. proxy main → 即 child を eager spawn (state="spawning")
 *   2. Claude → proxy: `initialize` を受信したら proxy 自前の synthetic
 *      response を **即返す** (child の起動完了を待たない)。並行して
 *      cachedInitialize を保持し、replayInitialize() を kick off。
 *   3. child の MCP layer (StdioServerTransport) が起動 → proxy が cached
 *      initialize を child に送り、child の response を内部で消費。
 *      cachedInitialized があれば forward。state="ready" に遷移。
 *   4. ready 化と同時に proxy が child の tools/list を fetch・cache し、
 *      `notifications/tools/list_changed` を Claude に送って refresh を促す。
 *   5. Claude → proxy: `tools/list` は **常に proxy 自前で synthetic 応答**
 *      (cachedTools + RESTART_TOOL の merge)。未 ready なら [RESTART_TOOL]
 *      のみ即返す (Option B)。
 *   6. `tools/call` は state=ready なら child へ forward、未 ready なら
 *      "server starting" で fail-fast。`restart_server` は proxy 自身が処理。
 *
 * その他:
 *   - child crash 時は指数バックオフで 5 回まで自動 respawn
 *   - restart / crash 中の in-flight request は fail-fast
 *   - shutdown 時は SIGTERM → 5s 待 → SIGKILL で確実に child を殺す
 */

import { join } from "node:path";
import type { ToolDefinition } from "../mcp/tools/registry.js";
import { getLogger } from "../shared/logger.js";
import {
  buildSyntheticInitializeResponse,
  buildSyntheticToolsListResponse,
  type ChildState,
  classifyClientMessage,
  extractLines,
  type JsonRpcLite,
  nextCrashRecoveryStep,
  performRestart,
  RESTART_TOOL,
  replayInitialize,
} from "./proxy-core.js";

const logger = getLogger("proxy");

const CHILD_ENTRY = join(import.meta.dirname, "../index.ts");
const CRASH_MAX_ATTEMPTS = 5;
const SHUTDOWN_GRACE_MS = 5000;
const TOOLS_LIST_FETCH_TIMEOUT_MS = 10000;

// ============================================================
// ManagedChild - intentionalKill を per-child で持つ (H1 fix)
// ============================================================

interface ManagedChild {
  // biome-ignore lint/suspicious/noExplicitAny: Bun.Subprocess の generic 型は流動的なので any
  proc: any;
  pid: number;
  intentionalKill: boolean;
}

let current: ManagedChild | null = null;

// ============================================================
// 共有 state
// ============================================================

let childState: ChildState = "spawning";
let restarting = false;
let crashAttempt = 0;

let cachedInitialize: JsonRpcLite | null = null;
let cachedInitializedNotification: JsonRpcLite | null = null;
let cachedToolsList: ToolDefinition[] | null = null;

/**
 * forward 済みで child からの response 待ちの client request id を tracking する。
 * restart / crash 時に対応する error response を返す fail-fast 用 (それ以外の用途は無い)。
 */
const clientPending = new Set<string | number>();
const proxyWaiters = new Map<string | number, (msg: JsonRpcLite) => void>();

let proxyIdCounter = 0;
function nextProxyId(): string {
  proxyIdCounter += 1;
  return `__proxy_${Date.now()}_${proxyIdCounter}`;
}

const PROXY_TOOLS: ToolDefinition[] = [RESTART_TOOL];

// ============================================================
// I/O
// ============================================================

function sendToClient(msg: JsonRpcLite): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function sendToChild(msg: JsonRpcLite): boolean {
  if (!current?.proc?.stdin) {
    return false;
  }
  try {
    current.proc.stdin.write(`${JSON.stringify(msg)}\n`);
    current.proc.stdin.flush();
    return true;
  } catch (e) {
    logger.warn(`sendToChild error: ${String(e)}`);
    return false;
  }
}

/**
 * proxy 自身が child に送る request の応答を待つ。
 * timeout は ms、応答なしは null を返す。id は呼び出し側で nextProxyId() してから渡すこと。
 */
function sendAndWait(
  req: JsonRpcLite,
  timeoutMs: number,
): Promise<JsonRpcLite | null> {
  return new Promise((resolve) => {
    const id = req.id;
    if (id === undefined || id === null) {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      proxyWaiters.delete(id);
      resolve(null);
    }, timeoutMs);
    proxyWaiters.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    if (!sendToChild(req)) {
      proxyWaiters.delete(id);
      clearTimeout(timer);
      resolve(null);
    }
  });
}

// ============================================================
// Spawn / lifecycle
// ============================================================

async function spawnChild(): Promise<ManagedChild> {
  const proc = Bun.spawn([process.execPath, "run", CHILD_ENTRY], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: process.env,
  });
  const managed: ManagedChild = {
    proc,
    pid: proc.pid,
    intentionalKill: false,
  };
  current = managed;
  logger.info(`child spawned pid=${managed.pid}`);

  pumpChildStdout(managed).catch((e) =>
    logger.error(`pumpChildStdout fatal: ${String(e)}`),
  );

  proc.exited.then((code: number) => {
    logger.warn(`child pid=${managed.pid} exited code=${code}`);
    if (managed.intentionalKill) return;
    handleCrash(managed).catch((e) =>
      logger.error(`handleCrash: ${String(e)}`),
    );
  });

  return managed;
}

async function pumpChildStdout(managed: ManagedChild): Promise<void> {
  const reader = managed.proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch (e) {
      logger.warn(`child stdout read error pid=${managed.pid}: ${String(e)}`);
      return;
    }
    if (chunk.done) return;
    buffer += decoder.decode(chunk.value, { stream: true });
    const { lines, remainder } = extractLines(buffer);
    buffer = remainder;
    for (const line of lines) {
      let msg: JsonRpcLite;
      try {
        msg = JSON.parse(line);
      } catch (_e) {
        logger.warn(`child non-JSON line: ${line.slice(0, 200)}`);
        continue;
      }
      handleChildMessage(msg);
    }
  }
}

async function pumpClientStdin(): Promise<void> {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of process.stdin as AsyncIterable<string>) {
    buffer += chunk;
    const { lines, remainder } = extractLines(buffer);
    buffer = remainder;
    for (const line of lines) {
      let msg: JsonRpcLite;
      try {
        msg = JSON.parse(line);
      } catch (_e) {
        logger.warn(`client non-JSON line: ${line.slice(0, 200)}`);
        continue;
      }
      handleClientMessage(msg);
    }
  }
  logger.info("client stdin closed, shutting down");
  await shutdown("stdin-eof");
}

// ============================================================
// State transitions
// ============================================================

/**
 * child の MCP layer 初期化が成功して使える状態になったら呼ぶ。
 * - cachedToolsList を child から fetch
 * - notifications/tools/list_changed を Claude に送信
 */
async function markReady(reason: string): Promise<void> {
  childState = "ready";
  logger.info(`child ready (reason=${reason}), fetching tools/list`);
  await fetchAndCacheToolsList();
  sendToClient({
    jsonrpc: "2.0",
    method: "notifications/tools/list_changed",
  });
}

async function fetchAndCacheToolsList(): Promise<void> {
  const fetchId = nextProxyId();
  const response = await sendAndWait(
    { jsonrpc: "2.0", id: fetchId, method: "tools/list" },
    TOOLS_LIST_FETCH_TIMEOUT_MS,
  );
  if (!response) {
    logger.warn("tools/list fetch timeout, cache stays unchanged");
    return;
  }
  if (response.error) {
    logger.warn(`tools/list fetch error: ${response.error.message}`);
    return;
  }
  const result = response.result as { tools?: unknown };
  if (Array.isArray(result?.tools)) {
    cachedToolsList = result.tools as ToolDefinition[];
    logger.info(`cached ${cachedToolsList.length} child tools`);
  }
}

/**
 * client から initialize を受け取ったタイミングで child の初期化を kick off する。
 * - 既に ready ならスキップ
 * - cachedInitialize を replay → 成功なら markReady
 */
async function kickoffChildInitialize(): Promise<void> {
  if (childState === "ready") return;
  if (childState === "give_up") return;
  if (!cachedInitialize) return;

  const result = await replayInitialize({
    cachedInitialize,
    cachedInitialized: cachedInitializedNotification,
    sendAndWait,
    sendToChild,
    nextProxyId,
  });

  if (result.kind === "ok") {
    await markReady("client-initiated");
  } else if (result.kind === "error") {
    logger.error(`kickoffChildInitialize error: ${result.error}`);
    // 失敗時はそのうち child crash で respawn → recovery が走る想定
  }
}

// ============================================================
// Message routing
// ============================================================

function handleClientMessage(msg: JsonRpcLite): void {
  const action = classifyClientMessage(msg, { restarting, childState });

  switch (action.kind) {
    case "intercept_initialize": {
      cachedInitialize = msg;
      sendToClient(buildSyntheticInitializeResponse(msg));
      kickoffChildInitialize().catch((e) =>
        logger.error(`kickoffChildInitialize fatal: ${String(e)}`),
      );
      return;
    }
    case "cache_initialized": {
      cachedInitializedNotification = msg;
      // ready なら今すぐ forward。spawning 中なら kickoffChildInitialize の
      // 末尾で forward される (replayInitialize が cachedInitialized を送る)。
      if (childState === "ready" && !restarting) {
        sendToChild(msg);
      }
      return;
    }
    case "synthetic_tools_list": {
      sendToClient(
        buildSyntheticToolsListResponse(msg, cachedToolsList, PROXY_TOOLS),
      );
      return;
    }
    case "intercept_restart": {
      handleRestartServer(msg).catch((e) =>
        logger.error(`restart_server fatal: ${String(e)}`),
      );
      return;
    }
    case "fail_fast": {
      sendToClient({
        jsonrpc: "2.0",
        id: msg.id ?? null,
        error: { code: -32000, message: action.message },
      });
      return;
    }
    case "drop":
      return;
    case "forward":
      break;
  }

  // request なら restart/crash 時の fail-fast 用に id を tracking
  if (
    msg.id !== undefined &&
    msg.id !== null &&
    typeof msg.method === "string"
  ) {
    clientPending.add(msg.id);
  }

  if (!sendToChild(msg)) {
    if (msg.id !== undefined && msg.id !== null) {
      clientPending.delete(msg.id);
      sendToClient({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32000, message: "child unavailable" },
      });
    }
  }
}

function handleChildMessage(msg: JsonRpcLite): void {
  // proxy 自身が待っている id (initialize replay / tools/list fetch 等) は
  // client に転送せず handler に渡す
  if (msg.id !== undefined && msg.id !== null && proxyWaiters.has(msg.id)) {
    const waiter = proxyWaiters.get(msg.id);
    proxyWaiters.delete(msg.id);
    waiter?.(msg);
    return;
  }

  // child が tools/list_changed を発行した場合は cache invalidate + 透過 forward
  if (msg.method === "notifications/tools/list_changed") {
    cachedToolsList = null;
    fetchAndCacheToolsList().catch((e) =>
      logger.warn(`re-fetch tools/list failed: ${String(e)}`),
    );
    sendToClient(msg);
    return;
  }

  // child からの response/notification は client にそのまま forward
  // (id があれば clientPending tracking を解放、無くても問題ない)
  if (msg.id !== undefined && msg.id !== null) {
    clientPending.delete(msg.id);
  }
  sendToClient(msg);
}

// ============================================================
// restart_server tool
// ============================================================

async function handleRestartServer(req: JsonRpcLite): Promise<void> {
  const reqId = req.id ?? null;

  if (restarting) {
    sendToClient({
      jsonrpc: "2.0",
      id: reqId,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: false, error: "already restarting" }),
          },
        ],
        isError: true,
      },
    });
    return;
  }

  let reason = "(no reason)";
  if (req.params !== null && typeof req.params === "object") {
    const args = (req.params as { arguments?: { reason?: unknown } }).arguments;
    if (args && typeof args.reason === "string") reason = args.reason;
  }
  const dyingChild = current;
  logger.info(
    `restart_server triggered: oldPid=${dyingChild?.pid} reason="${reason}"`,
  );

  restarting = true;
  childState = "spawning";
  cachedToolsList = null;

  // in-flight client request は fail-fast、proxy 自身の waiter もクリア
  for (const id of clientPending) {
    sendToClient({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: "server restarting" },
    });
  }
  clientPending.clear();
  proxyWaiters.clear();

  const start = Date.now();
  const spawnResult = await performRestart({
    oldPid: dyingChild?.pid,
    killAndWaitOldChild: () => killAndWait(dyingChild),
    spawnNewChild: async () => {
      const newChild = await spawnChild();
      return { pid: newChild.pid };
    },
    now: () => Date.now(),
  });

  if (!spawnResult.ok) {
    restarting = false;
    logger.error(`restart_server kill/spawn failed: ${spawnResult.error}`);
    sendToClient({
      jsonrpc: "2.0",
      id: reqId,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: false, error: spawnResult.error }),
          },
        ],
        isError: true,
      },
    });
    return;
  }

  const initResult = await replayInitialize({
    cachedInitialize,
    cachedInitialized: cachedInitializedNotification,
    sendAndWait,
    sendToChild,
    nextProxyId,
  });

  restarting = false;

  if (initResult.kind === "error") {
    logger.error(
      `restart_server initialize replay failed: ${initResult.error}`,
    );
    sendToClient({
      jsonrpc: "2.0",
      id: reqId,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: false, error: initResult.error }),
          },
        ],
        isError: true,
      },
    });
    return;
  }

  // initResult が "ok" or "skipped" (cachedInitialize なし)
  if (initResult.kind === "ok") {
    await markReady("restart");
  }
  crashAttempt = 0;

  sendToClient({
    jsonrpc: "2.0",
    id: reqId,
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            oldPid: spawnResult.oldPid,
            newPid: spawnResult.newPid,
            durationMs: Date.now() - start,
            reason,
          }),
        },
      ],
    },
  });
  logger.info(
    `restart_server done: newPid=${spawnResult.newPid} durationMs=${Date.now() - start}`,
  );
}

/** child を SIGTERM → 5s 待 → SIGKILL の段で殺す。dyingChild が null なら即 return */
async function killAndWait(dyingChild: ManagedChild | null): Promise<void> {
  if (!dyingChild) return;
  dyingChild.intentionalKill = true;
  dyingChild.proc.kill("SIGTERM");
  const code = await Promise.race<number | -1>([
    dyingChild.proc.exited,
    new Promise<-1>((res) => setTimeout(() => res(-1), SHUTDOWN_GRACE_MS)),
  ]);
  if (code === -1) {
    logger.warn(
      `child pid=${dyingChild.pid} did not exit in ${SHUTDOWN_GRACE_MS}ms, sending SIGKILL`,
    );
    dyingChild.proc.kill("SIGKILL");
    await dyingChild.proc.exited;
  }
}

// ============================================================
// Crash recovery (指数バックオフ、最大 5 回)
// ============================================================

async function handleCrash(deadChild: ManagedChild): Promise<void> {
  if (childState === "give_up") return;
  if (current && current !== deadChild) {
    logger.info(
      `handleCrash: deadChild pid=${deadChild.pid} but current is pid=${current.pid}, skipping`,
    );
    return;
  }
  if (restarting) return;

  childState = "spawning";
  cachedToolsList = null;

  for (const id of clientPending) {
    sendToClient({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: "child crashed" },
    });
  }
  clientPending.clear();
  proxyWaiters.clear();

  const step = nextCrashRecoveryStep({
    currentAttempt: crashAttempt,
    maxAttempts: CRASH_MAX_ATTEMPTS,
  });

  if (step.kind === "give_up") {
    childState = "give_up";
    logger.error(
      `child crashed ${CRASH_MAX_ATTEMPTS} times, giving up. Claude 側に空 tool list を通知。`,
    );
    sendToClient({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    });
    return;
  }

  crashAttempt = step.nextAttempt;
  logger.warn(
    `respawn attempt ${crashAttempt} after ${step.delayMs}ms backoff`,
  );
  await new Promise((r) => setTimeout(r, step.delayMs));

  // M3: 寝てる間に restart_server が走った可能性 → restart に譲る
  if (restarting) {
    logger.info(
      `crash recovery yielded to in-progress restart (attempt=${crashAttempt})`,
    );
    return;
  }

  try {
    await spawnChild();
    const initResult = await replayInitialize({
      cachedInitialize,
      cachedInitialized: cachedInitializedNotification,
      sendAndWait,
      sendToChild,
      nextProxyId,
    });
    if (initResult.kind === "error") {
      throw new Error(initResult.error);
    }
    if (initResult.kind === "ok") {
      await markReady("post-crash-recovery");
    }
    const attempts = crashAttempt;
    crashAttempt = 0;
    logger.info(`recovery successful after ${attempts} attempt(s)`);
  } catch (e) {
    logger.error(`respawn ${crashAttempt} failed: ${String(e)}`);
    handleCrash(current ?? deadChild).catch(() => {});
  }
}

// ============================================================
// Shutdown (M2: signal でも child の exit を timeout 付きで待つ)
// ============================================================

async function shutdown(reason: string): Promise<void> {
  logger.info(`shutdown begin: reason=${reason}`);
  if (current) {
    try {
      await killAndWait(current);
    } catch (e) {
      logger.warn(`shutdown killAndWait error: ${String(e)}`);
    }
  }
  process.exit(0);
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
  process.on("SIGINT", () => {
    shutdown("SIGINT").catch((e) => {
      logger.error(`shutdown error on SIGINT: ${String(e)}`);
      process.exit(1);
    });
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch((e) => {
      logger.error(`shutdown error on SIGTERM: ${String(e)}`);
      process.exit(1);
    });
  });

  // child を eager spawn（client が initialize を送る前から起動を進める）
  await spawnChild();

  pumpClientStdin().catch((e) =>
    logger.error(`pumpClientStdin fatal: ${String(e)}`),
  );
}

main().catch((e) => {
  logger.error(`proxy main fatal: ${String(e)}`);
  process.exit(1);
});
