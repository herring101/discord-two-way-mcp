/**
 * Discord MCP self-hosting proxy (HER-79).
 *
 * Claude Code から見た MCP server はこの proxy。proxy が内部で本体の
 * Discord MCP server (`src/index.ts`) を child process として spawn し、
 * Claude ↔ proxy ↔ child の stdio 仲介を行う。
 *
 * 機能:
 *   - tools/list の結果に `restart_server` tool を合算
 *   - `restart_server` tool 呼び出しで child を kill → respawn → re-initialize
 *   - child crash 時は指数バックオフで 5 回まで自動 respawn
 *   - restart / crash 中の in-flight request は "server restarting" / "child crashed" で fail-fast
 *
 * 設計参照: HER-79 確定設計書 (mcp-hot-reload neilopet/mcp-server-hmr の設計を参考、import なし)
 */

import { join } from "node:path";
import { getLogger } from "../shared/logger.js";
import {
  classifyClientMessage,
  extractLines,
  type JsonRpcLite,
  maybeInjectIntoToolsListResult,
  nextCrashRecoveryStep,
  performRestart,
  RESTART_TOOL,
} from "./proxy-core.js";

const logger = getLogger("proxy");

const CHILD_ENTRY = join(import.meta.dirname, "../index.ts");
const CRASH_MAX_ATTEMPTS = 5;
const SHUTDOWN_GRACE_MS = 5000;

// ============================================================
// ManagedChild - intentionalKill を per-child で持つ (H1 fix)
// ============================================================

interface ManagedChild {
  // biome-ignore lint/suspicious/noExplicitAny: Bun.Subprocess の generic 型は流動的なので any
  proc: any;
  pid: number;
  /**
   * この child を意図的に kill しているフラグ。restart や proxy shutdown 時に true。
   * 各 child の `exited.then` は自分の ManagedChild 経由でこの値を見るので、
   * 別 child のための fla リセットの影響を受けない。
   */
  intentionalKill: boolean;
}

let current: ManagedChild | null = null;

// ============================================================
// 共有 state
// ============================================================

let restarting = false;
let crashAttempt = 0;
let crashGiveUp = false;

let cachedInitialize: JsonRpcLite | null = null;
let cachedInitializedNotification: JsonRpcLite | null = null;

const clientPending = new Map<string | number, { method: string }>();
const proxyWaiters = new Map<string | number, (msg: JsonRpcLite) => void>();

let proxyIdCounter = 0;
function nextProxyId(): string {
  proxyIdCounter += 1;
  return `__proxy_${Date.now()}_${proxyIdCounter}`;
}

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

  // 並列で stdout を読み続ける
  pumpChildStdout(managed).catch((e) =>
    logger.error(`pumpChildStdout fatal: ${String(e)}`),
  );

  // 終了を監視。closure で managed を捕まえているので global flag race を避ける
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
// Message routing
// ============================================================

function handleClientMessage(msg: JsonRpcLite): void {
  // initialize / initialized は restart 時の replay 用にキャッシュ
  if (msg.method === "initialize") {
    cachedInitialize = msg;
  } else if (msg.method === "notifications/initialized") {
    cachedInitializedNotification = msg;
  }

  const action = classifyClientMessage(msg, { restarting, crashGiveUp });

  switch (action.kind) {
    case "intercept_restart":
      handleRestartServer(msg).catch((e) =>
        logger.error(`restart_server fatal: ${String(e)}`),
      );
      return;
    case "fail_fast":
      sendToClient({
        jsonrpc: "2.0",
        id: msg.id ?? null,
        error: { code: -32000, message: action.message },
      });
      return;
    case "drop":
      // notification は drop（child が居ない/restart 中）
      return;
    case "forward":
      break;
  }

  // request なら response routing 用に id を控える
  if (
    msg.id !== undefined &&
    msg.id !== null &&
    typeof msg.method === "string"
  ) {
    clientPending.set(msg.id, { method: msg.method });
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
  // proxy 自身が待っている id (initialize replay 等) は client に転送せず handler に渡す
  if (msg.id !== undefined && msg.id !== null && proxyWaiters.has(msg.id)) {
    const waiter = proxyWaiters.get(msg.id);
    proxyWaiters.delete(msg.id);
    waiter?.(msg);
    return;
  }

  // tools/list レスポンスに restart_server を合算
  let outgoing = msg;
  if (msg.id !== undefined && msg.id !== null && clientPending.has(msg.id)) {
    const p = clientPending.get(msg.id);
    clientPending.delete(msg.id);
    if (p?.method === "tools/list") {
      outgoing = maybeInjectIntoToolsListResult(msg, [RESTART_TOOL]);
    }
  }

  sendToClient(outgoing);
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

  // in-flight client request は fail-fast、proxy 自身の waiter もクリア
  for (const id of clientPending.keys()) {
    sendToClient({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: "server restarting" },
    });
  }
  clientPending.clear();
  proxyWaiters.clear();

  const result = await performRestart({
    oldPid: dyingChild?.pid,
    cachedInitialize,
    cachedInitialized: cachedInitializedNotification,
    killAndWaitOldChild: () => killAndWait(dyingChild),
    spawnNewChild: async () => {
      const newChild = await spawnChild();
      return { pid: newChild.pid };
    },
    sendAndWait,
    sendToChild,
    nextProxyId,
  });

  restarting = false;

  if (result.ok) {
    crashAttempt = 0;
    sendToClient({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    });
    sendToClient({
      jsonrpc: "2.0",
      id: reqId,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              oldPid: result.oldPid,
              newPid: result.newPid,
              durationMs: result.durationMs,
              reason,
            }),
          },
        ],
      },
    });
    logger.info(
      `restart_server done: newPid=${result.newPid} durationMs=${result.durationMs}`,
    );
  } else {
    logger.error(`restart_server failed: ${result.error}`);
    sendToClient({
      jsonrpc: "2.0",
      id: reqId,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: false, error: result.error }),
          },
        ],
        isError: true,
      },
    });
  }
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
// Crash recovery (指数バックオフ、最大 5 回)
// ============================================================

async function handleCrash(deadChild: ManagedChild): Promise<void> {
  if (crashGiveUp) return;
  // restart 経由で殺された child の通知ならここには来ない (intentionalKill=true)。
  // この時点で current が deadChild と異なる場合、新 child が既に spawn 済みなので何もしない。
  if (current && current !== deadChild) {
    logger.info(
      `handleCrash: deadChild pid=${deadChild.pid} but current is pid=${current.pid}, skipping`,
    );
    return;
  }
  if (restarting) return;

  // in-flight client request は fail-fast
  for (const id of clientPending.keys()) {
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
    crashGiveUp = true;
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
    const newChild = await spawnChild();
    if (cachedInitialize) {
      const replay: JsonRpcLite = {
        ...cachedInitialize,
        id: nextProxyId(),
      };
      const initResponse = await sendAndWait(replay, 15000);
      if (!initResponse || initResponse.error) {
        throw new Error(
          initResponse?.error
            ? `post-crash initialize error: ${initResponse.error.message}`
            : "post-crash initialize timeout",
        );
      }
      if (cachedInitializedNotification) {
        sendToChild(cachedInitializedNotification);
      }
    }
    const attempts = crashAttempt;
    crashAttempt = 0;
    logger.info(
      `recovery successful pid=${newChild.pid} after ${attempts} attempt(s)`,
    );
    sendToClient({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    });
  } catch (e) {
    logger.error(`respawn ${crashAttempt} failed: ${String(e)}`);
    // current は失敗 spawn の child を指している可能性があるので、deadChild としては
    // 「current が指している (or null) を再帰で渡す」だけで OK
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

  await spawnChild();
  pumpClientStdin().catch((e) =>
    logger.error(`pumpClientStdin fatal: ${String(e)}`),
  );
}

main().catch((e) => {
  logger.error(`proxy main fatal: ${String(e)}`);
  process.exit(1);
});
