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
  backoffMs,
  extractLines,
  mergeTools,
  RESTART_TOOL,
  RESTART_TOOL_NAME,
} from "./proxy-core.js";

const logger = getLogger("proxy");

const CHILD_ENTRY = join(import.meta.dirname, "../index.ts");

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ============================================================
// State
// ============================================================

// biome-ignore lint/suspicious/noExplicitAny: Bun.Subprocess generic 型は流動的なので any
let child: any = null;
let intentionalKill = false;
let restarting = false;
let crashAttempt = 0;
let crashGiveUp = false;

let cachedInitialize: JsonRpcMessage | null = null;
let cachedInitializedNotification: JsonRpcMessage | null = null;

const clientPending = new Map<string | number, { method: string }>();
const proxyWaiters = new Map<string | number, (msg: JsonRpcMessage) => void>();

let proxyIdCounter = 0;
function nextProxyId(): string {
  proxyIdCounter += 1;
  return `__proxy_${Date.now()}_${proxyIdCounter}`;
}

// ============================================================
// I/O
// ============================================================

function sendToClient(msg: JsonRpcMessage): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function sendToChild(msg: JsonRpcMessage): boolean {
  if (!child?.stdin) {
    return false;
  }
  try {
    child.stdin.write(`${JSON.stringify(msg)}\n`);
    child.stdin.flush();
    return true;
  } catch (e) {
    logger.warn(`sendToChild error: ${String(e)}`);
    return false;
  }
}

// ============================================================
// Spawn / lifecycle
// ============================================================

async function spawnChild(): Promise<void> {
  intentionalKill = false;
  child = Bun.spawn([process.execPath, "run", CHILD_ENTRY], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: process.env,
  });
  logger.info(`child spawned pid=${child.pid}`);

  // 並列で stdout を読み続ける
  pumpChildStdout(child).catch((e) =>
    logger.error(`pumpChildStdout fatal: ${String(e)}`),
  );

  // 終了を監視
  const exitedRef = child;
  child.exited.then((code: number) => {
    logger.warn(`child pid=${exitedRef.pid} exited code=${code}`);
    if (intentionalKill) return;
    handleCrash().catch((e) => logger.error(`handleCrash: ${String(e)}`));
  });
}

// biome-ignore lint/suspicious/noExplicitAny: Bun.Subprocess 由来
async function pumpChildStdout(c: any): Promise<void> {
  const reader = c.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch (e) {
      logger.warn(`child stdout read error: ${String(e)}`);
      return;
    }
    if (chunk.done) return;
    buffer += decoder.decode(chunk.value, { stream: true });
    const { lines, remainder } = extractLines(buffer);
    buffer = remainder;
    for (const line of lines) {
      let msg: JsonRpcMessage;
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
      let msg: JsonRpcMessage;
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
  intentionalKill = true;
  child?.kill("SIGTERM");
  process.exit(0);
}

// ============================================================
// Message routing
// ============================================================

function handleClientMessage(msg: JsonRpcMessage): void {
  // initialize / initialized は restart 時の replay 用にキャッシュ
  if (msg.method === "initialize") {
    cachedInitialize = msg;
  } else if (msg.method === "notifications/initialized") {
    cachedInitializedNotification = msg;
  }

  // restart_server tool call は proxy 自身が処理（child には forward しない）
  if (
    msg.method === "tools/call" &&
    msg.params !== null &&
    typeof msg.params === "object" &&
    (msg.params as { name?: unknown }).name === RESTART_TOOL_NAME
  ) {
    handleRestartServer(msg).catch((e) =>
      logger.error(`restart_server fatal: ${String(e)}`),
    );
    return;
  }

  // restart 中の request は fail-fast（notification は単に drop）
  if (
    restarting &&
    msg.id !== undefined &&
    msg.id !== null &&
    typeof msg.method === "string"
  ) {
    sendToClient({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32000, message: "server restarting" },
    });
    return;
  }

  // crash give-up 状態：tool 呼び出し系は失敗、それ以外は drop
  if (
    crashGiveUp &&
    msg.id !== undefined &&
    msg.id !== null &&
    typeof msg.method === "string"
  ) {
    sendToClient({
      jsonrpc: "2.0",
      id: msg.id,
      error: {
        code: -32000,
        message: "child unavailable (crash recovery exhausted)",
      },
    });
    return;
  }

  // tools/list 等のレスポンスを後で intercept できるよう pending に記録
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

function handleChildMessage(msg: JsonRpcMessage): void {
  // proxy 自身が待っている id（initialize replay 等）は client に転送せず handler に渡す
  if (msg.id !== undefined && msg.id !== null && proxyWaiters.has(msg.id)) {
    const waiter = proxyWaiters.get(msg.id);
    proxyWaiters.delete(msg.id);
    waiter?.(msg);
    return;
  }

  // tools/list レスポンスに restart_server を合算
  if (msg.id !== undefined && msg.id !== null && clientPending.has(msg.id)) {
    const p = clientPending.get(msg.id);
    clientPending.delete(msg.id);
    if (
      p?.method === "tools/list" &&
      msg.result !== null &&
      typeof msg.result === "object"
    ) {
      const result = msg.result as { tools?: unknown };
      if (Array.isArray(result.tools)) {
        result.tools = mergeTools(
          result.tools as Parameters<typeof mergeTools>[0],
          [RESTART_TOOL],
        );
      }
    }
  }

  sendToClient(msg);
}

// ============================================================
// restart_server tool
// ============================================================

async function handleRestartServer(req: JsonRpcMessage): Promise<void> {
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

  const start = Date.now();
  const oldPid: number | undefined = child?.pid;
  let reason = "(no reason)";
  if (req.params !== null && typeof req.params === "object") {
    const args = (req.params as { arguments?: { reason?: unknown } }).arguments;
    if (args && typeof args.reason === "string") reason = args.reason;
  }
  logger.info(`restart_server triggered: oldPid=${oldPid} reason="${reason}"`);

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

  try {
    // 1. graceful kill (SIGTERM 5s → SIGKILL)
    if (child && oldPid !== undefined) {
      intentionalKill = true;
      child.kill("SIGTERM");
      const exitedPromise: Promise<number> = child.exited;
      const timeoutPromise = new Promise<-1>((res) =>
        setTimeout(() => res(-1), 5000),
      );
      const code = await Promise.race([exitedPromise, timeoutPromise]);
      if (code === -1) {
        logger.warn("child did not exit in 5s, sending SIGKILL");
        child.kill("SIGKILL");
        await child.exited;
      }
    }

    // 2. 新 child spawn
    await spawnChild();

    // 3. initialize replay（cache がある場合のみ）
    if (cachedInitialize) {
      const replayId = nextProxyId();
      const replayInit: JsonRpcMessage = { ...cachedInitialize, id: replayId };
      const initResponse = await sendAndWait(replayInit, 15000);
      if (!initResponse) {
        throw new Error("child initialize timeout (15s)");
      }
      if (initResponse.error) {
        throw new Error(
          `child initialize error: ${initResponse.error.message}`,
        );
      }
      if (cachedInitializedNotification) {
        sendToChild(cachedInitializedNotification);
      }
    }

    restarting = false;
    crashAttempt = 0;

    // 4. tools list 変化通知
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
              oldPid,
              newPid: child?.pid,
              durationMs: Date.now() - start,
              reason,
            }),
          },
        ],
      },
    });
    logger.info(
      `restart_server done: newPid=${child?.pid} durationMs=${Date.now() - start}`,
    );
  } catch (e) {
    restarting = false;
    const errMsg = e instanceof Error ? e.message : String(e);
    logger.error(`restart_server failed: ${errMsg}`);
    sendToClient({
      jsonrpc: "2.0",
      id: reqId,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: false, error: errMsg }),
          },
        ],
        isError: true,
      },
    });
  }
}

/**
 * proxy 自身が child に送る request の応答を待つ（id を proxyWaiters に登録）。
 * timeout は ms、応答なしは null を返す。
 */
function sendAndWait(
  req: JsonRpcMessage,
  timeoutMs: number,
): Promise<JsonRpcMessage | null> {
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

const CRASH_MAX_ATTEMPTS = 5;

async function handleCrash(): Promise<void> {
  if (crashGiveUp) return;
  if (restarting) return; // restart 中の exit は意図通り

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

  crashAttempt += 1;
  if (crashAttempt > CRASH_MAX_ATTEMPTS) {
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

  const delay = backoffMs(crashAttempt);
  logger.warn(`respawn attempt ${crashAttempt} after ${delay}ms backoff`);
  await new Promise((r) => setTimeout(r, delay));

  try {
    await spawnChild();
    if (cachedInitialize) {
      const replayId = nextProxyId();
      const replayInit: JsonRpcMessage = { ...cachedInitialize, id: replayId };
      const initResponse = await sendAndWait(replayInit, 15000);
      if (!initResponse || initResponse.error) {
        throw new Error("post-crash initialize failed");
      }
      if (cachedInitializedNotification) {
        sendToChild(cachedInitializedNotification);
      }
    }
    const attempts = crashAttempt;
    crashAttempt = 0;
    logger.info(`recovery successful after ${attempts} attempt(s)`);
    sendToClient({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    });
  } catch (e) {
    logger.error(`respawn ${crashAttempt} failed: ${String(e)}`);
    handleCrash().catch(() => {});
  }
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
  process.on("SIGINT", () => {
    logger.info("SIGINT received, shutting down");
    intentionalKill = true;
    child?.kill("SIGTERM");
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    logger.info("SIGTERM received, shutting down");
    intentionalKill = true;
    child?.kill("SIGTERM");
    process.exit(0);
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
