/**
 * 汎用スケジューラーの型定義
 */

/**
 * スケジュール定義
 */
export type Schedule =
  | { type: "once"; executeAt: Date }
  | { type: "interval"; intervalMs: number; startAt?: Date }
  | { type: "cron"; cronExpression: string }
  | { type: "exponential"; meanIntervalMs: number };

/**
 * ジョブペイロード（実行時に何をするか）
 */
export type JobPayload =
  | { type: "reminder"; content: string }
  | { type: "activity_tick" }
  | { type: "promotion_tick" };

/**
 * スケジュールされたジョブ
 */
export interface ScheduledJob {
  id: string;
  name: string;
  schedule: Schedule;
  payload: JobPayload;
  enabled: boolean;
  createdAt: Date;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
}

/**
 * ジョブ作成時の入力（id, createdAt, lastRunAt, nextRunAt は自動生成）
 */
export type CreateJobInput = Omit<
  ScheduledJob,
  "id" | "createdAt" | "lastRunAt" | "nextRunAt"
>;

/**
 * ジョブ実行ハンドラー
 */
export type JobHandler = (job: ScheduledJob) => Promise<void>;
