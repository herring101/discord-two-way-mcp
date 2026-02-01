/**
 * Scheduler クラスのテスト
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Scheduler } from "./scheduler.js";
import type { JobPayload, Schedule, ScheduledJob } from "./types.js";

// ============================================================
// モック用ヘルパー
// ============================================================

// タイマーIDカウンター
let timerIdCounter = 0;
// 登録されたタイマー
let timers: Map<number, { callback: () => void; delay: number; time: number }>;
// 現在の仮想時刻
let currentTime: number;

// オリジナルの setTimeout/clearTimeout を保存
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;

function setupTimerMocks(): void {
  timers = new Map();
  timerIdCounter = 0;
  currentTime = Date.now();

  // setTimeout をモック
  globalThis.setTimeout = ((callback: () => void, delay: number) => {
    const id = ++timerIdCounter;
    timers.set(id, { callback, delay, time: currentTime + delay });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  // clearTimeout をモック
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    timers.delete(id as unknown as number);
  }) as typeof clearTimeout;
}

function restoreTimerMocks(): void {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}

// 時間を進めて期限切れタイマーを実行
async function advanceTimersByTime(ms: number): Promise<void> {
  currentTime += ms;

  const expiredTimers: Array<() => void> = [];

  for (const [id, timer] of timers) {
    if (timer.time <= currentTime) {
      expiredTimers.push(timer.callback);
      timers.delete(id);
    }
  }

  // 期限切れタイマーを実行
  for (const callback of expiredTimers) {
    callback();
  }

  // 非同期処理を待機
  await new Promise((resolve) => originalSetTimeout(resolve, 0));
}

// ============================================================
// Prisma モック
// ============================================================

function createMockPrisma() {
  const jobs: Map<string, Record<string, unknown>> = new Map();

  return {
    scheduledJob: {
      findMany: mock(async () => Array.from(jobs.values())),
      findFirst: mock(async ({ where }: { where: { id: string } }) =>
        jobs.get(where.id),
      ),
      create: mock(async ({ data }: { data: Record<string, unknown> }) => {
        const id = `job-${jobs.size + 1}`;
        const job = {
          id,
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
          lastRunAt: null,
        };
        jobs.set(id, job);
        return job;
      }),
      update: mock(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const job = jobs.get(where.id);
          if (job) {
            Object.assign(job, data, { updatedAt: new Date() });
          }
          return job;
        },
      ),
      delete: mock(async ({ where }: { where: { id: string } }) => {
        const job = jobs.get(where.id);
        jobs.delete(where.id);
        return job;
      }),
    },
    _jobs: jobs, // テスト用にアクセス可能に
  };
}

// ============================================================
// テスト
// ============================================================

describe("Scheduler", () => {
  let mockPrisma: ReturnType<typeof createMockPrisma>;
  let scheduler: Scheduler;

  beforeEach(() => {
    setupTimerMocks();
    mockPrisma = createMockPrisma();
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    scheduler = new Scheduler(mockPrisma as any);
  });

  afterEach(() => {
    scheduler.cleanup();
    restoreTimerMocks();
  });

  describe("addJob", () => {
    test("once ジョブを追加できる", async () => {
      const schedule: Schedule = {
        type: "once",
        executeAt: new Date(currentTime + 60000), // 1分後
      };
      const payload: JobPayload = { type: "reminder", content: "テスト" };

      const job = await scheduler.addJob({
        name: "test-reminder",
        schedule,
        payload,
        enabled: true,
      });

      expect(job.id).toBeDefined();
      expect(job.name).toBe("test-reminder");
      expect(job.schedule).toEqual(schedule);
      expect(job.payload).toEqual(payload);
      expect(job.enabled).toBe(true);
    });

    test("interval ジョブを追加できる", async () => {
      const schedule: Schedule = {
        type: "interval",
        intervalMs: 5 * 60 * 1000, // 5分
      };
      const payload: JobPayload = { type: "activity_tick" };

      const job = await scheduler.addJob({
        name: "activity-tick",
        schedule,
        payload,
        enabled: true,
      });

      expect(job.schedule.type).toBe("interval");
      expect(job.payload.type).toBe("activity_tick");
    });
  });

  describe("removeJob", () => {
    test("ジョブを削除できる", async () => {
      const job = await scheduler.addJob({
        name: "test",
        schedule: { type: "once", executeAt: new Date(currentTime + 60000) },
        payload: { type: "reminder", content: "test" },
        enabled: true,
      });

      const removed = await scheduler.removeJob(job.id);
      expect(removed).toBe(true);

      const jobs = scheduler.listJobs();
      expect(jobs.find((j) => j.id === job.id)).toBeUndefined();
    });

    test("存在しないジョブの削除は false を返す", async () => {
      const removed = await scheduler.removeJob("non-existent");
      expect(removed).toBe(false);
    });
  });

  describe("setJobEnabled", () => {
    test("ジョブを無効化できる", async () => {
      const job = await scheduler.addJob({
        name: "test",
        schedule: { type: "interval", intervalMs: 60000 },
        payload: { type: "activity_tick" },
        enabled: true,
      });

      await scheduler.setJobEnabled(job.id, false);

      const updatedJob = scheduler.listJobs().find((j) => j.id === job.id);
      expect(updatedJob?.enabled).toBe(false);
    });

    test("ジョブを再有効化できる", async () => {
      const job = await scheduler.addJob({
        name: "test",
        schedule: { type: "interval", intervalMs: 60000 },
        payload: { type: "activity_tick" },
        enabled: false,
      });

      await scheduler.setJobEnabled(job.id, true);

      const updatedJob = scheduler.listJobs().find((j) => j.id === job.id);
      expect(updatedJob?.enabled).toBe(true);
    });
  });

  describe("registerHandler と実行", () => {
    test("ハンドラーが呼び出される", async () => {
      const handler = mock(async (_job: ScheduledJob) => {});

      scheduler.registerHandler("reminder", handler);

      await scheduler.addJob({
        name: "test-reminder",
        schedule: { type: "once", executeAt: new Date(currentTime + 100) },
        payload: { type: "reminder", content: "テスト" },
        enabled: true,
      });

      expect(handler).not.toHaveBeenCalled();

      // 時間を進める
      await advanceTimersByTime(150);

      expect(handler).toHaveBeenCalledTimes(1);
      const firstCall = handler.mock.calls[0];
      expect(firstCall).toBeDefined();
      expect(firstCall?.[0]?.payload).toEqual({
        type: "reminder",
        content: "テスト",
      });
    });

    test("interval ジョブは繰り返し実行される", async () => {
      const handler = mock(async (_job: ScheduledJob) => {});

      scheduler.registerHandler("activity_tick", handler);

      await scheduler.addJob({
        name: "activity",
        schedule: { type: "interval", intervalMs: 100 },
        payload: { type: "activity_tick" },
        enabled: true,
      });

      // 1回目
      await advanceTimersByTime(100);
      expect(handler).toHaveBeenCalledTimes(1);

      // 2回目
      await advanceTimersByTime(100);
      expect(handler).toHaveBeenCalledTimes(2);

      // 3回目
      await advanceTimersByTime(100);
      expect(handler).toHaveBeenCalledTimes(3);
    });

    test("once ジョブは1回だけ実行される", async () => {
      const handler = mock(async (_job: ScheduledJob) => {});

      scheduler.registerHandler("reminder", handler);

      const job = await scheduler.addJob({
        name: "once-reminder",
        schedule: { type: "once", executeAt: new Date(currentTime + 100) },
        payload: { type: "reminder", content: "一度だけ" },
        enabled: true,
      });

      await advanceTimersByTime(100);
      expect(handler).toHaveBeenCalledTimes(1);

      // 追加で時間を進めても再実行されない
      await advanceTimersByTime(1000);
      expect(handler).toHaveBeenCalledTimes(1);

      // ジョブが無効化されている
      const updatedJob = scheduler.listJobs().find((j) => j.id === job.id);
      expect(updatedJob?.enabled).toBe(false);
    });

    test("無効化されたジョブは実行されない", async () => {
      const handler = mock(async (_job: ScheduledJob) => {});

      scheduler.registerHandler("reminder", handler);

      const job = await scheduler.addJob({
        name: "disabled",
        schedule: { type: "once", executeAt: new Date(currentTime + 100) },
        payload: { type: "reminder", content: "無効" },
        enabled: true,
      });

      // すぐに無効化
      await scheduler.setJobEnabled(job.id, false);

      await advanceTimersByTime(150);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("findJobByName", () => {
    test("名前でジョブを検索できる", async () => {
      await scheduler.addJob({
        name: "unique-name",
        schedule: { type: "once", executeAt: new Date(currentTime + 60000) },
        payload: { type: "reminder", content: "test" },
        enabled: true,
      });

      const found = scheduler.findJobByName("unique-name");
      expect(found).toBeDefined();
      expect(found?.name).toBe("unique-name");
    });

    test("存在しない名前は undefined を返す", () => {
      const found = scheduler.findJobByName("non-existent");
      expect(found).toBeUndefined();
    });
  });

  describe("cleanup", () => {
    test("全タイマーがクリアされる", async () => {
      const handler = mock(async (_job: ScheduledJob) => {});
      scheduler.registerHandler("reminder", handler);

      await scheduler.addJob({
        name: "job1",
        schedule: { type: "once", executeAt: new Date(currentTime + 1000) },
        payload: { type: "reminder", content: "1" },
        enabled: true,
      });

      await scheduler.addJob({
        name: "job2",
        schedule: { type: "once", executeAt: new Date(currentTime + 2000) },
        payload: { type: "reminder", content: "2" },
        enabled: true,
      });

      // クリーンアップ
      scheduler.cleanup();

      // タイマーが実行されても呼ばれない
      await advanceTimersByTime(3000);
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
