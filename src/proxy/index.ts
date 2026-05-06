/**
 * Discord MCP self-hosting proxy (HER-79).
 *
 * Claude Code から見た MCP server はこの proxy。proxy が内部で本体の
 * Discord MCP server (`src/index.ts`) を child process として spawn し、
 * Claude ↔ proxy ↔ child の stdio 仲介を行う。
 *
 * 起動シーケンス (Phase 1 修正後、MCP 2025-03-26 spec lifecycle 準拠):
 *   1. proxy main → 即 child を eager spawn (proxyState="idle")
 *   2. Claude → proxy: `initialize` 受信
 *      → 「initialize request received (protocolVersion=...)」ログ
 *      → proxy 自前の synthetic response を **即返却** (child 待たず)
 *      → proxyState="initialize_received" に遷移
 *      → 「initialize response sent」ログ
 *   3. Claude → proxy: `notifications/initialized` 受信
 *      → 「initialized notification received」ログ
 *      → proxyState="client_initialized" に遷移
 *      → ここで初めて child の init replay を kick off
 *        (Phase 1-B: spec "server SHOULD NOT send before initialized" 違反防止)
 *   4. proxy → child: cached initialize を replay → child の応答を内部消費
 *      → cached notifications/initialized を child に forward
 *      → 「child init started」ログ
 *   5. proxy → child: tools/list を fetch して cache
 *      → 「child ready, tools cached (N items)」ログ
 *   6. proxy → Claude: `notifications/tools/list_changed` 送信
 *      → proxyState="running" に遷移
 *      → 「tools/list_changed sent」ログ
 *   7. Claude → proxy: `tools/list` は常に proxy 自前で synthetic 応答
 *      (cachedTools + RESTART_TOOL の merge、未 cache なら [RESTART_TOOL] のみ = Option B)
 *   8. `tools/call` は proxyState="running" + !restarting なら child へ forward、
 *      未 ready なら "server starting" で fail-fast。`restart_server` は proxy 自身が処理。
 *
 * その他:
 *   - child crash 時は指数バックオフで 5 回まで自動 respawn
 *   - restart / crash 中の in-flight request は fail-fast
 *   - shutdown 時は SIGTERM → 5s 待 → SIGKILL で確実に child を殺す
 *   - notifications/tools/list_changed は proxyState >= client_initialized
 *     の状態でのみ送信 (Phase 1-C: spec 違反防止)
 */

import { join } from "node:path";
import type { ToolDefinition } from "../mcp/tools/registry.js";
import { getLogger } from "../shared/logger.js";
import {
  buildSyntheticInitializeResponse,
  buildSyntheticToolsListResponse,
  classifyClientMessage,
  extractLines,
  type JsonRpcLite,
  nextCrashRecoveryStep,
  type ProxyState,
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

let proxyState: ProxyState = "idle";
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
// State transitions / lifecycle helpers
// ============================================================

/** child から tools/list を取得して cachedToolsList を更新する。 */
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
  }
}

/**
 * `notifications/tools/list_changed` を Claude に送信する。
 * MCP spec 上、client が `notifications/initialized` を送る前に
 * server-initiated request/notification を送るのは禁止なので、
 * proxyState が client_initialized 以降であることをガードする。
 *
 * - proxyState が client_initialized: running に遷移してから送信
 * - proxyState が running: そのまま送信 (restart / crash recovery 後の再通知)
 * - それ以外: 送信しない (spec 違反防止)
 */
function emitToolsListChanged(reason: string): void {
  if (proxyState === "client_initialized") {
    proxyState = "running";
  } else if (proxyState !== "running") {
    logger.warn(
      `emitToolsListChanged skipped: proxyState=${proxyState} (reason=${reason})`,
    );
    return;
  }
  sendToClient({
    jsonrpc: "2.0",
    method: "notifications/tools/list_changed",
  });
  logger.info(`tools/list_changed sent (reason=${reason})`);
}

/**
 * child の init replay → tools/list キャッシュ → list_changed 送信のシーケンス。
 * `notifications/initialized` を client から受信した直後 (`cache_initialized`)
 * および restart / crash recovery 後の child 再初期化時に呼ぶ。
 *
 * cachedInitialize が無い場合は skipped を返す (idle / initialize_received で
 * 呼ばれる想定外ケース)。
 */
async function initializeChildAndPublishTools(
  reason: string,
): Promise<"ok" | "skipped" | "error"> {
  if (proxyState === "give_up") return "skipped";
  if (!cachedInitialize) return "skipped";

  logger.info(`child init started (reason=${reason})`);
  const result = await replayInitialize({
    cachedInitialize,
    cachedInitialized: cachedInitializedNotification,
    sendAndWait,
    sendToChild,
    nextProxyId,
  });
  if (result.kind === "error") {
    logger.error(`child init failed (reason=${reason}): ${result.error}`);
    return "error";
  }
  if (result.kind === "skipped") return "skipped";

  await fetchAndCacheToolsList();
  logger.info(
    `child ready, tools cached (${cachedToolsList?.length ?? 0} items)`,
  );
  emitToolsListChanged(reason);
  return "ok";
}

// ============================================================
// Message routing
// ============================================================

function handleClientMessage(msg: JsonRpcLite): void {
  const action = classifyClientMessage(msg, { restarting, proxyState });

  switch (action.kind) {
    case "intercept_initialize": {
      // Phase 1-A: protocolVersion を確実に echo する synthetic response。
      // Phase 1-B: child init は client.notifications/initialized 受信後まで
      // kick off しない (spec: server SHOULD NOT send before initialized)。
      cachedInitialize = msg;
      const params = (msg.params ?? {}) as { protocolVersion?: unknown };
      const echoVersion =
        typeof params.protocolVersion === "string"
          ? params.protocolVersion
          : "(missing, using proxy default)";
      logger.info(
        `initialize request received (protocolVersion=${echoVersion})`,
      );
      sendToClient(buildSyntheticInitializeResponse(msg));
      proxyState = "initialize_received";
      logger.info("initialize response sent");
      return;
    }
    case "cache_initialized": {
      cachedInitializedNotification = msg;
      if (proxyState === "initialize_received") {
        proxyState = "client_initialized";
        logger.info("initialized notification received");
        // ここで初めて child init を kick off (Phase 1-B)
        initializeChildAndPublishTools("client-initialized").catch((e) =>
          logger.error(`initializeChildAndPublishTools fatal: ${String(e)}`),
        );
      } else {
        logger.warn(
          `initialized received in unexpected state=${proxyState}, ignored (cached for restart replay)`,
        );
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

  // child が tools/list_changed を発行した場合: cache invalidate + 再 fetch +
  // proxyState が running の場合のみ client に通知 (Phase 1-C: spec 違反防止)
  if (msg.method === "notifications/tools/list_changed") {
    cachedToolsList = null;
    (async () => {
      await fetchAndCacheToolsList();
      emitToolsListChanged("child-emitted-list-changed");
    })().catch((e) => logger.warn(`re-fetch tools/list failed: ${String(e)}`));
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

  // child init replay + tools 再 cache + list_changed 送信
  // (proxyState が client_initialized 以降の場合のみ list_changed を送る)
  const initStatus = await initializeChildAndPublishTools("restart");
  restarting = false;

  if (initStatus === "error") {
    sendToClient({
      jsonrpc: "2.0",
      id: reqId,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: "child initialize replay failed",
            }),
          },
        ],
        isError: true,
      },
    });
    return;
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
  if (proxyState === "give_up") return;
  if (current && current !== deadChild) {
    logger.info(
      `handleCrash: deadChild pid=${deadChild.pid} but current is pid=${current.pid}, skipping`,
    );
    return;
  }
  if (restarting) return;

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
    proxyState = "give_up";
    logger.error(
      `child crashed ${CRASH_MAX_ATTEMPTS} times, giving up. Claude 側に空 tool list を通知。`,
    );
    // client が initialized 済みだった場合に限り、空 tool list の refresh を促す。
    // (cachedInitializedNotification 有無でクライアントの状態進度を判断、
    //  spec "server SHOULD NOT send before initialized" 違反防止)
    if (cachedInitializedNotification !== null) {
      sendToClient({
        jsonrpc: "2.0",
        method: "notifications/tools/list_changed",
      });
      logger.info("tools/list_changed sent (reason=give_up)");
    }
    return;
  }

  crashAttempt = step.nextAttempt;
  logger.warn(
    `respawn attempt ${crashAttempt} after ${step.delayMs}ms backoff`,
  );
  await new Promise((r) => setTimeout(r, step.delayMs));

  // 寝てる間に restart_server が走った可能性 → restart に譲る (M3)
  if (restarting) {
    logger.info(
      `crash recovery yielded to in-progress restart (attempt=${crashAttempt})`,
    );
    return;
  }

  try {
    await spawnChild();
    const initStatus = await initializeChildAndPublishTools(
      `post-crash-recovery (attempt ${crashAttempt})`,
    );
    if (initStatus === "error") {
      throw new Error("child initialize replay failed");
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
