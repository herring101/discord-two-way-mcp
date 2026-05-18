import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "./logger.js";
import { getTmuxSession } from "./tmux.js";

const logger = getLogger("trace-audit");
const ROOT_DIR = join(import.meta.dirname, "../..");
const TRACE_FILE = join(ROOT_DIR, "data/mcp-trace-events.jsonl");
const PREVIEW_LIMIT = 200;

export type TraceEventName =
  | "set_send_target"
  | "clear_send_target"
  | "send_message"
  | "upload_file";

export interface TraceAuditEvent {
  event: TraceEventName;
  traceId?: string;
  channelId?: string;
  replyToMessageId?: string | null;
  messageId?: string;
  fileName?: string;
  fileSize?: number;
  contentPreview?: string;
  success: boolean;
  error?: string | null;
}

function preview(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.replace(/\s+/g, " ").trim().slice(0, PREVIEW_LIMIT);
}

function makeTraceId(event: TraceAuditEvent): string {
  return [
    event.event,
    event.channelId ?? "no-channel",
    event.replyToMessageId ?? "no-reply",
    Date.now().toString(36),
  ].join(":");
}

export function appendTraceEvent(event: TraceAuditEvent): void {
  try {
    mkdirSync(join(ROOT_DIR, "data"), { recursive: true });
    const record = {
      ts: new Date().toISOString(),
      session: getTmuxSession(),
      traceId: event.traceId ?? makeTraceId(event),
      ...event,
      contentPreview: preview(event.contentPreview),
      error: preview(event.error ?? undefined) ?? null,
    };
    appendFileSync(TRACE_FILE, `${JSON.stringify(record)}\n`);
  } catch (error) {
    logger.warn(
      `trace audit append failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
