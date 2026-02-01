/**
 * 次回実行時刻を計算する純粋関数
 */

import { CronExpressionParser } from "cron-parser";
import type { Schedule } from "./types.js";

/**
 * 指数分布からサンプリング
 * 平均 meanMs ミリ秒の指数分布に従う待機時間を返す
 */
export function sampleExponential(meanMs: number): number {
  const u = Math.random();
  return -Math.log(u) * meanMs;
}

/**
 * 過去時刻かどうかを判定
 */
export function isPastTime(time: Date, now: Date): boolean {
  return time.getTime() <= now.getTime();
}

/**
 * cron 式から次回実行時刻を計算
 */
export function getNextCronTime(
  cronExpression: string,
  after: Date,
): Date | null {
  try {
    const parser = CronExpressionParser.parse(cronExpression, {
      currentDate: after,
      tz: "Asia/Tokyo",
    });
    return parser.next().toDate();
  } catch {
    return null;
  }
}

/**
 * 次回実行時刻を計算する純粋関数
 *
 * @param schedule スケジュール定義
 * @param now 現在時刻
 * @param lastRunAt 前回実行時刻（interval で使用）
 * @returns 次回実行時刻、または null（実行終了）
 */
export function computeNextRunAt(
  schedule: Schedule,
  now: Date,
  lastRunAt: Date | null,
): Date | null {
  switch (schedule.type) {
    case "once": {
      // 過去なら null（実行済みまたは無効）
      return schedule.executeAt > now ? schedule.executeAt : null;
    }

    case "interval": {
      // 基準時刻: lastRunAt > startAt > now
      const base = lastRunAt ?? schedule.startAt ?? now;
      const nextTime = new Date(base.getTime() + schedule.intervalMs);

      // 計算結果が過去なら、now から intervalMs 後
      if (nextTime <= now) {
        return new Date(now.getTime() + schedule.intervalMs);
      }
      return nextTime;
    }

    case "cron": {
      return getNextCronTime(schedule.cronExpression, now);
    }

    case "exponential": {
      // 指数分布でサンプリング
      const delay = sampleExponential(schedule.meanIntervalMs);
      return new Date(now.getTime() + delay);
    }

    default: {
      // TypeScript exhaustive check
      const _exhaustive: never = schedule;
      return null;
    }
  }
}

/**
 * スケジュールが繰り返しかどうかを判定
 */
export function isRepeatingSchedule(schedule: Schedule): boolean {
  return (
    schedule.type === "interval" ||
    schedule.type === "cron" ||
    schedule.type === "exponential"
  );
}
