#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const ROOT_DIR = join(import.meta.dirname, "..");
const DB_DIR = join(ROOT_DIR, "data/db");
const LOG_DIR = join(ROOT_DIR, "data/logs");
const TRACE_FILE = join(ROOT_DIR, "data/mcp-trace-events.jsonl");
const MAX_SET_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_RECENT_HOURS = 24;
const INCOMPLETE_TARGET_TIMEOUT_MS = 10 * 60 * 1000;

interface EnabledJobRow {
  id: string;
  name: string;
  payloadType: string;
  payloadData: string;
  nextRunAt: string | null;
}

interface LongHorizonJob {
  botId: string;
  id: string;
  name: string;
  payloadType: string;
  nextRunAt: string;
  delayMs: number;
  content?: string;
}

interface BotSummary {
  botId: string;
  dbFile: string;
  enabledJobs: number;
  enabledReminders: number;
  longHorizonJobs: LongHorizonJob[];
  error?: string;
}

interface HealthcheckSummary {
  generatedAt: string;
  recentHours: number;
  botCount: number;
  enabledJobs: number;
  enabledReminders: number;
  longHorizonJobs: LongHorizonJob[];
  recentTimeoutOverflow: number;
  recentTmuxSendFailures: number;
  traceSummary: TraceSummary;
  botSummaries: BotSummary[];
}

interface TraceEventRow {
  ts?: string;
  event?: string;
  session?: string | null;
  traceId?: string;
  channelId?: string;
  replyToMessageId?: string | null;
  messageId?: string;
  success?: boolean;
  error?: string | null;
}

interface TraceSummary {
  recentEvents: number;
  setTargets: number;
  completedTargets: number;
  incompleteTargets: IncompleteTarget[];
  failedEvents: number;
}

interface IncompleteTarget {
  ts: string;
  session: string | null;
  channelId: string;
  replyToMessageId: string | null;
  ageMinutes: number;
}

function recentCutoffMs(hours: number): number {
  return Date.now() - hours * 60 * 60 * 1000;
}

function parseArgs(): { json: boolean; recentHours: number } {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const hoursArg = args.find((arg) => arg.startsWith("--hours="));
  const recentHours = hoursArg
    ? Number.parseInt(hoursArg.slice("--hours=".length), 10)
    : DEFAULT_RECENT_HOURS;

  return {
    json,
    recentHours: Number.isFinite(recentHours)
      ? recentHours
      : DEFAULT_RECENT_HOURS,
  };
}

function botIdFromDbFile(dbFile: string): string {
  return basename(dbFile).replace(/^bot_/, "").replace(/\.sqlite$/, "");
}

function parsePayloadContent(payloadData: string): string | undefined {
  try {
    const parsed = JSON.parse(payloadData) as { content?: unknown };
    return typeof parsed.content === "string" ? parsed.content : undefined;
  } catch {
    return undefined;
  }
}

function findBotDbs(): string[] {
  if (!existsSync(DB_DIR)) {
    return [];
  }
  return readdirSync(DB_DIR)
    .filter((name) => /^bot_.+\.sqlite$/.test(name))
    .map((name) => join(DB_DIR, name))
    .sort();
}

function summarizeBotDb(dbFile: string): BotSummary {
  const botId = botIdFromDbFile(dbFile);
  const db = new Database(dbFile, { readonly: true });

  try {
    const enabledRows = db
      .query(
        "SELECT id, name, payloadType, payloadData, nextRunAt FROM ScheduledJob WHERE enabled = 1",
      )
      .all() as EnabledJobRow[];

    const now = Date.now();
    const longHorizonJobs = enabledRows.flatMap((row) => {
      if (!row.nextRunAt) {
        return [];
      }

      const runAtMs = new Date(row.nextRunAt).getTime();
      if (!Number.isFinite(runAtMs)) {
        return [];
      }

      const delayMs = runAtMs - now;
      if (delayMs <= MAX_SET_TIMEOUT_MS) {
        return [];
      }

      return [
        {
          botId,
          id: row.id,
          name: row.name,
          payloadType: row.payloadType,
          nextRunAt: row.nextRunAt,
          delayMs,
          content: parsePayloadContent(row.payloadData),
        },
      ];
    });

    return {
      botId,
      dbFile,
      enabledJobs: enabledRows.length,
      enabledReminders: enabledRows.filter(
        (row) => row.payloadType === "reminder",
      ).length,
      longHorizonJobs,
    };
  } catch (error) {
    return {
      botId,
      dbFile,
      enabledJobs: 0,
      enabledReminders: 0,
      longHorizonJobs: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db.close();
  }
}

function readLogText(fileName: string): string {
  const path = join(LOG_DIR, fileName);
  if (!existsSync(path)) {
    return "";
  }
  return readFileSync(path).toString("utf8").replaceAll("\0", "");
}

function countRecentLogMatches(
  logText: string,
  pattern: RegExp,
  cutoffMs: number,
): number {
  let count = 0;
  for (const line of logText.split("\n")) {
    if (!pattern.test(line)) {
      continue;
    }
    pattern.lastIndex = 0;

    const timestampMatch = line.match(/^\[([^\]]+)\]/);
    if (!timestampMatch?.[1]) {
      continue;
    }

    const timestampMs = new Date(timestampMatch[1]).getTime();
    if (Number.isFinite(timestampMs) && timestampMs >= cutoffMs) {
      count += 1;
    }
  }
  return count;
}

function readRecentTraceEvents(cutoffMs: number): TraceEventRow[] {
  if (!existsSync(TRACE_FILE)) {
    return [];
  }

  const rows: TraceEventRow[] = [];
  const text = readFileSync(TRACE_FILE, "utf8").replaceAll("\0", "");
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    try {
      const row = JSON.parse(line) as TraceEventRow;
      const timestampMs = row.ts ? new Date(row.ts).getTime() : Number.NaN;
      if (Number.isFinite(timestampMs) && timestampMs >= cutoffMs) {
        rows.push(row);
      }
    } catch {
      continue;
    }
  }
  return rows;
}

function eventKey(event: TraceEventRow): string {
  return [
    event.session ?? "no-session",
    event.channelId ?? "no-channel",
    event.replyToMessageId ?? "no-reply",
  ].join("|");
}

function summarizeTraceEvents(
  events: TraceEventRow[],
  nowMs = Date.now(),
): TraceSummary {
  const setTargets = events.filter(
    (event) => event.event === "set_send_target" && event.success !== false,
  );
  const completions = new Map<string, TraceEventRow[]>();

  for (const event of events) {
    if (
      event.event === "send_message" ||
      event.event === "upload_file" ||
      event.event === "clear_send_target"
    ) {
      const key = eventKey(event);
      completions.set(key, [...(completions.get(key) ?? []), event]);
    }
  }

  let completedTargets = 0;
  const incompleteTargets: IncompleteTarget[] = [];
  for (const target of setTargets) {
    const targetMs = target.ts ? new Date(target.ts).getTime() : Number.NaN;
    if (!Number.isFinite(targetMs)) {
      continue;
    }

    const matchingCompletion = (completions.get(eventKey(target)) ?? []).find(
      (event) => {
        const eventMs = event.ts ? new Date(event.ts).getTime() : Number.NaN;
        return Number.isFinite(eventMs) && eventMs >= targetMs;
      },
    );

    if (matchingCompletion) {
      completedTargets += 1;
      continue;
    }

    const ageMs = nowMs - targetMs;
    if (ageMs >= INCOMPLETE_TARGET_TIMEOUT_MS) {
      incompleteTargets.push({
        ts: target.ts ?? "",
        session: target.session ?? null,
        channelId: target.channelId ?? "",
        replyToMessageId: target.replyToMessageId ?? null,
        ageMinutes: Math.round(ageMs / 60_000),
      });
    }
  }

  return {
    recentEvents: events.length,
    setTargets: setTargets.length,
    completedTargets,
    incompleteTargets,
    failedEvents: events.filter((event) => event.success === false).length,
  };
}

function buildSummary(recentHours: number): HealthcheckSummary {
  const botSummaries = findBotDbs().map(summarizeBotDb);
  const longHorizonJobs = botSummaries.flatMap((bot) => bot.longHorizonJobs);
  const cutoffMs = recentCutoffMs(recentHours);
  const combinedLogs = `${readLogText("app.log")}\n${readLogText("error.log")}`;
  const recentTraceEvents = readRecentTraceEvents(cutoffMs);

  return {
    generatedAt: new Date().toISOString(),
    recentHours,
    botCount: botSummaries.length,
    enabledJobs: botSummaries.reduce((sum, bot) => sum + bot.enabledJobs, 0),
    enabledReminders: botSummaries.reduce(
      (sum, bot) => sum + bot.enabledReminders,
      0,
    ),
    longHorizonJobs,
    recentTimeoutOverflow: countRecentLogMatches(
      combinedLogs,
      /TimeoutOverflow/i,
      cutoffMs,
    ),
    recentTmuxSendFailures: countRecentLogMatches(
      combinedLogs,
      /Failed to send message to tmux/i,
      cutoffMs,
    ),
    traceSummary: summarizeTraceEvents(recentTraceEvents),
    botSummaries,
  };
}

function formatDuration(ms: number): string {
  const days = ms / (24 * 60 * 60 * 1000);
  return `${days.toFixed(1)}d`;
}

function formatMarkdown(summary: HealthcheckSummary): string {
  const lines = [
    "# Discord MCP Healthcheck",
    "",
    `Generated: ${summary.generatedAt}`,
    `Recent window: ${summary.recentHours}h`,
    "",
    "## Summary",
    "",
    `- Bot DBs: ${summary.botCount}`,
    `- Enabled jobs: ${summary.enabledJobs}`,
    `- Enabled reminders: ${summary.enabledReminders}`,
    `- Long-horizon jobs over setTimeout max: ${summary.longHorizonJobs.length}`,
    `- Recent TimeoutOverflow: ${summary.recentTimeoutOverflow}`,
    `- Recent tmux send failures: ${summary.recentTmuxSendFailures}`,
    `- Recent trace events: ${summary.traceSummary.recentEvents}`,
    `- Recent send target completions: ${summary.traceSummary.completedTargets}/${summary.traceSummary.setTargets}`,
    `- Recent incomplete targets: ${summary.traceSummary.incompleteTargets.length}`,
    `- Recent failed trace events: ${summary.traceSummary.failedEvents}`,
    "",
    "## Bot DBs",
    "",
  ];

  for (const bot of summary.botSummaries) {
    lines.push(
      `- ${bot.botId}: jobs=${bot.enabledJobs}, reminders=${bot.enabledReminders}, longHorizon=${bot.longHorizonJobs.length}${
        bot.error ? `, error=${bot.error}` : ""
      }`,
    );
  }

  if (summary.longHorizonJobs.length > 0) {
    lines.push(
      "",
      "## Long-Horizon Jobs",
      "",
      "These jobs are farther out than one native setTimeout window. The scheduler should wake at the max timer delay, re-check due time, and reschedule instead of executing early.",
      "",
    );
    for (const job of summary.longHorizonJobs) {
      lines.push(
        `- ${job.botId} ${job.name} (${job.id}): nextRunAt=${job.nextRunAt}, delay=${formatDuration(job.delayMs)}`,
      );
      if (job.content) {
        lines.push(`  content=${job.content.slice(0, 120)}`);
      }
    }
  }

  if (summary.traceSummary.incompleteTargets.length > 0) {
    lines.push("", "## Incomplete Send Targets", "");
    for (const target of summary.traceSummary.incompleteTargets) {
      lines.push(
        `- ${target.ts} session=${target.session ?? "unknown"} channel=${target.channelId} reply=${target.replyToMessageId ?? "none"} age=${target.ageMinutes}m`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

const { json, recentHours } = parseArgs();
const summary = buildSummary(recentHours);

if (json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(formatMarkdown(summary));
}
