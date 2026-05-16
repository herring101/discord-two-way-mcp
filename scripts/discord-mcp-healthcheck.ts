#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const ROOT_DIR = join(import.meta.dirname, "..");
const DB_DIR = join(ROOT_DIR, "data/db");
const LOG_DIR = join(ROOT_DIR, "data/logs");
const MAX_SET_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_RECENT_HOURS = 24;

interface EnabledJobRow {
  id: string;
  name: string;
  payloadType: string;
  payloadData: string;
  nextRunAt: string | null;
}

interface RiskyReminder {
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
  riskyFutureJobs: RiskyReminder[];
  error?: string;
}

interface HealthcheckSummary {
  generatedAt: string;
  recentHours: number;
  botCount: number;
  enabledJobs: number;
  enabledReminders: number;
  riskyFutureJobs: RiskyReminder[];
  recentTimeoutOverflow: number;
  recentTmuxSendFailures: number;
  botSummaries: BotSummary[];
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
    const riskyFutureJobs = enabledRows.flatMap((row) => {
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
      riskyFutureJobs,
    };
  } catch (error) {
    return {
      botId,
      dbFile,
      enabledJobs: 0,
      enabledReminders: 0,
      riskyFutureJobs: [],
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

function buildSummary(recentHours: number): HealthcheckSummary {
  const botSummaries = findBotDbs().map(summarizeBotDb);
  const riskyFutureJobs = botSummaries.flatMap((bot) => bot.riskyFutureJobs);
  const cutoffMs = recentCutoffMs(recentHours);
  const combinedLogs = `${readLogText("app.log")}\n${readLogText("error.log")}`;

  return {
    generatedAt: new Date().toISOString(),
    recentHours,
    botCount: botSummaries.length,
    enabledJobs: botSummaries.reduce((sum, bot) => sum + bot.enabledJobs, 0),
    enabledReminders: botSummaries.reduce(
      (sum, bot) => sum + bot.enabledReminders,
      0,
    ),
    riskyFutureJobs,
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
    `- Future jobs over setTimeout max: ${summary.riskyFutureJobs.length}`,
    `- Recent TimeoutOverflow: ${summary.recentTimeoutOverflow}`,
    `- Recent tmux send failures: ${summary.recentTmuxSendFailures}`,
    "",
    "## Bot DBs",
    "",
  ];

  for (const bot of summary.botSummaries) {
    lines.push(
      `- ${bot.botId}: jobs=${bot.enabledJobs}, reminders=${bot.enabledReminders}, risky=${bot.riskyFutureJobs.length}${
        bot.error ? `, error=${bot.error}` : ""
      }`,
    );
  }

  if (summary.riskyFutureJobs.length > 0) {
    lines.push("", "## Risky Future Jobs", "");
    for (const job of summary.riskyFutureJobs) {
      lines.push(
        `- ${job.botId} ${job.name} (${job.id}): nextRunAt=${job.nextRunAt}, delay=${formatDuration(job.delayMs)}`,
      );
      if (job.content) {
        lines.push(`  content=${job.content.slice(0, 120)}`);
      }
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
