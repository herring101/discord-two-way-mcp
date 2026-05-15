/**
 * 汎用スケジューラー
 * 5分タイマー、確率昇格、リマインダーを統一的に管理
 */

import type { PrismaClient } from "../db/generated/prisma/client.js";
import { getLogger } from "../shared/logger.js";
import { computeNextRunAt, isRepeatingSchedule } from "./compute.js";
import type {
  CreateJobInput,
  JobHandler,
  JobPayload,
  Schedule,
  ScheduledJob,
} from "./types.js";

const logger = getLogger("scheduler");
const MAX_SET_TIMEOUT_MS = 2_147_483_647;

function getDelayMs(runAt: Date): number {
  return Math.max(0, runAt.getTime() - Date.now());
}

function clampTimerDelay(delayMs: number): number {
  return Math.min(delayMs, MAX_SET_TIMEOUT_MS);
}

function isDue(runAt: Date): boolean {
  return getDelayMs(runAt) === 0;
}

/**
 * スケジュールを JSON 文字列にシリアライズ
 */
function serializeSchedule(schedule: Schedule): {
  scheduleType: string;
  scheduleData: string;
} {
  const scheduleData: Record<string, unknown> = {};

  switch (schedule.type) {
    case "once":
      scheduleData.executeAt = schedule.executeAt.toISOString();
      break;
    case "interval":
      scheduleData.intervalMs = schedule.intervalMs;
      if (schedule.startAt) {
        scheduleData.startAt = schedule.startAt.toISOString();
      }
      break;
    case "cron":
      scheduleData.cronExpression = schedule.cronExpression;
      break;
    case "exponential":
      scheduleData.meanIntervalMs = schedule.meanIntervalMs;
      break;
  }

  return {
    scheduleType: schedule.type,
    scheduleData: JSON.stringify(scheduleData),
  };
}

/**
 * JSON 文字列からスケジュールをデシリアライズ
 */
function deserializeSchedule(
  scheduleType: string,
  scheduleData: string,
): Schedule {
  const data = JSON.parse(scheduleData);

  switch (scheduleType) {
    case "once":
      return { type: "once", executeAt: new Date(data.executeAt) };
    case "interval":
      return {
        type: "interval",
        intervalMs: data.intervalMs,
        startAt: data.startAt ? new Date(data.startAt) : undefined,
      };
    case "cron":
      return { type: "cron", cronExpression: data.cronExpression };
    case "exponential":
      return { type: "exponential", meanIntervalMs: data.meanIntervalMs };
    default:
      throw new Error(`Unknown schedule type: ${scheduleType}`);
  }
}

/**
 * ペイロードを JSON 文字列にシリアライズ
 */
function serializePayload(payload: JobPayload): {
  payloadType: string;
  payloadData: string;
} {
  const payloadData: Record<string, unknown> = {};

  switch (payload.type) {
    case "reminder":
      payloadData.content = payload.content;
      break;
    case "activity_tick":
    case "promotion_tick":
    case "sleep_start":
      // データなし
      break;
  }

  return {
    payloadType: payload.type,
    payloadData: JSON.stringify(payloadData),
  };
}

/**
 * JSON 文字列からペイロードをデシリアライズ
 */
function deserializePayload(
  payloadType: string,
  payloadData: string,
): JobPayload {
  const data = JSON.parse(payloadData);

  switch (payloadType) {
    case "reminder":
      return { type: "reminder", content: data.content };
    case "activity_tick":
      return { type: "activity_tick" };
    case "promotion_tick":
      return { type: "promotion_tick" };
    case "sleep_start":
      return { type: "sleep_start" };
    default:
      throw new Error(`Unknown payload type: ${payloadType}`);
  }
}

/**
 * 汎用スケジューラークラス
 */
export class Scheduler {
  private jobs: Map<string, ScheduledJob> = new Map();
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private handlers: Map<string, JobHandler> = new Map();

  constructor(private prisma: PrismaClient) {}

  /**
   * 起動時に DB からジョブを復元
   */
  async initialize(): Promise<void> {
    const dbJobs = await this.prisma.scheduledJob.findMany({
      where: { enabled: true },
    });

    for (const dbJob of dbJobs) {
      const job = this.dbToJob(dbJob);
      this.jobs.set(job.id, job);

      // nextRunAt を再計算して更新
      const now = new Date();
      const nextRunAt = computeNextRunAt(job.schedule, now, job.lastRunAt);

      if (nextRunAt) {
        job.nextRunAt = nextRunAt;
        await this.updateNextRunAt(job.id, nextRunAt);
        this.scheduleTimer(job);
      } else if (!isRepeatingSchedule(job.schedule)) {
        // once ジョブで過去になったら無効化
        await this.setJobEnabled(job.id, false);
      }
    }

    logger.info(`[Scheduler] Initialized with ${this.jobs.size} jobs`);
  }

  /**
   * ジョブを追加
   */
  async addJob(input: CreateJobInput): Promise<ScheduledJob> {
    const now = new Date();
    const nextRunAt = computeNextRunAt(input.schedule, now, null);

    const { scheduleType, scheduleData } = serializeSchedule(input.schedule);
    const { payloadType, payloadData } = serializePayload(input.payload);

    const dbJob = await this.prisma.scheduledJob.create({
      data: {
        name: input.name,
        scheduleType,
        scheduleData,
        payloadType,
        payloadData,
        enabled: input.enabled,
        nextRunAt,
      },
    });

    const job: ScheduledJob = {
      id: dbJob.id,
      name: input.name,
      schedule: input.schedule,
      payload: input.payload,
      enabled: input.enabled,
      createdAt: dbJob.createdAt,
      lastRunAt: null,
      nextRunAt,
    };

    this.jobs.set(job.id, job);

    if (job.enabled && nextRunAt) {
      this.scheduleTimer(job);
    }

    logger.debug(`[Scheduler] Added job: ${job.name} (${job.id})`);
    return job;
  }

  /**
   * ジョブを削除
   */
  async removeJob(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job) {
      return false;
    }

    // タイマーをクリア
    this.clearTimer(jobId);

    // DB から削除
    await this.prisma.scheduledJob.delete({
      where: { id: jobId },
    });

    this.jobs.delete(jobId);
    logger.debug(`[Scheduler] Removed job: ${job.name} (${jobId})`);
    return true;
  }

  /**
   * ジョブの有効/無効を切り替え
   */
  async setJobEnabled(jobId: string, enabled: boolean): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }

    job.enabled = enabled;

    await this.prisma.scheduledJob.update({
      where: { id: jobId },
      data: { enabled },
    });

    if (enabled) {
      // 次回実行時刻を再計算
      const now = new Date();
      const nextRunAt = computeNextRunAt(job.schedule, now, job.lastRunAt);
      if (nextRunAt) {
        job.nextRunAt = nextRunAt;
        await this.updateNextRunAt(jobId, nextRunAt);
        this.scheduleTimer(job);
      }
    } else {
      this.clearTimer(jobId);
    }

    logger.debug(`[Scheduler] Job ${job.name} enabled: ${enabled}`);
  }

  /**
   * 全ジョブを取得
   */
  listJobs(): ScheduledJob[] {
    return Array.from(this.jobs.values());
  }

  /**
   * 名前でジョブを検索
   */
  findJobByName(name: string): ScheduledJob | undefined {
    return Array.from(this.jobs.values()).find((job) => job.name === name);
  }

  /**
   * ハンドラーを登録
   */
  registerHandler(payloadType: string, handler: JobHandler): void {
    this.handlers.set(payloadType, handler);
    logger.debug(`[Scheduler] Registered handler for: ${payloadType}`);
  }

  /**
   * クリーンアップ（シャットダウン時）
   */
  cleanup(): void {
    for (const [jobId] of this.timers) {
      this.clearTimer(jobId);
    }
    logger.info("[Scheduler] Cleanup complete");
  }

  // ============================================================
  // Private methods
  // ============================================================

  private dbToJob(
    dbJob: Awaited<ReturnType<typeof this.prisma.scheduledJob.findFirst>>,
  ): ScheduledJob {
    if (!dbJob) {
      throw new Error("Job not found");
    }

    return {
      id: dbJob.id,
      name: dbJob.name,
      schedule: deserializeSchedule(dbJob.scheduleType, dbJob.scheduleData),
      payload: deserializePayload(dbJob.payloadType, dbJob.payloadData),
      enabled: dbJob.enabled,
      createdAt: dbJob.createdAt,
      lastRunAt: dbJob.lastRunAt,
      nextRunAt: dbJob.nextRunAt,
    };
  }

  private scheduleTimer(job: ScheduledJob): void {
    if (!job.nextRunAt) {
      return;
    }

    // 既存のタイマーをクリア
    this.clearTimer(job.id);

    const timerDelay = clampTimerDelay(getDelayMs(job.nextRunAt));

    const timer = setTimeout(() => {
      this.executeJob(job.id).catch((error) => {
        logger.error(`[Scheduler] Failed to execute job ${job.name}:`, error);
      });
    }, timerDelay);

    this.timers.set(job.id, timer);
    logger.debug(
      `[Scheduler] Scheduled ${job.name} in ${Math.round(timerDelay / 1000)}s`,
    );
  }

  private clearTimer(jobId: string): void {
    const timer = this.timers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(jobId);
    }
  }

  private async executeJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || !job.enabled) {
      return;
    }

    const dueAt = job.nextRunAt;
    if (!dueAt) {
      return;
    }
    if (!isDue(dueAt)) {
      this.scheduleTimer(job);
      return;
    }

    const handler = this.handlers.get(job.payload.type);
    if (!handler) {
      logger.warn(
        `[Scheduler] No handler for payload type: ${job.payload.type}`,
      );
      return;
    }

    logger.debug(`[Scheduler] Executing job: ${job.name}`);

    const now = new Date();
    const isRepeating = isRepeatingSchedule(job.schedule);
    const nextRunAt = isRepeating
      ? computeNextRunAt(job.schedule, now, now)
      : null;

    const claim = await this.prisma.scheduledJob.updateMany({
      where: {
        id: jobId,
        enabled: true,
        nextRunAt: dueAt,
      },
      data: {
        lastRunAt: now,
        nextRunAt,
        enabled: isRepeating,
      },
    });

    if (claim.count !== 1) {
      logger.debug(`[Scheduler] Skipped already-claimed job: ${job.name}`);
      return;
    }

    job.lastRunAt = now;
    job.nextRunAt = nextRunAt;
    job.enabled = isRepeating;

    try {
      await handler(job);
    } catch (error) {
      logger.error(`[Scheduler] Handler error for ${job.name}:`, error);
    }

    // 繰り返しスケジュールなら次回を計算
    if (isRepeating) {
      if (nextRunAt) {
        this.scheduleTimer(job);
      }
    } else {
      // once ジョブはメモリから削除し、DBも削除
      this.clearTimer(jobId);
      this.jobs.delete(jobId);
      await this.prisma.scheduledJob.deleteMany({
        where: { id: jobId },
      });
      logger.debug(`[Scheduler] Removed completed once job: ${job.name}`);
    }
  }

  private async updateNextRunAt(jobId: string, nextRunAt: Date): Promise<void> {
    await this.prisma.scheduledJob.update({
      where: { id: jobId },
      data: { nextRunAt },
    });
  }
}
