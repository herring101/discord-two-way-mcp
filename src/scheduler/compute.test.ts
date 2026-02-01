/**
 * compute.ts のテスト
 */

import { describe, expect, test } from "bun:test";
import {
  computeNextRunAt,
  getNextCronTime,
  isPastTime,
  isRepeatingSchedule,
} from "./compute.js";
import type { Schedule } from "./types.js";

describe("isPastTime", () => {
  test("過去時刻は true を返す", () => {
    const now = new Date("2024-01-01T12:00:00Z");
    const time = new Date("2024-01-01T10:00:00Z");
    expect(isPastTime(time, now)).toBe(true);
  });

  test("未来時刻は false を返す", () => {
    const now = new Date("2024-01-01T10:00:00Z");
    const time = new Date("2024-01-01T12:00:00Z");
    expect(isPastTime(time, now)).toBe(false);
  });

  test("同時刻は true を返す（境界）", () => {
    const now = new Date("2024-01-01T10:00:00Z");
    expect(isPastTime(now, now)).toBe(true);
  });
});

describe("getNextCronTime", () => {
  test("毎日9時(JST)の cron 式", () => {
    // JST 8時 = UTC 23時（前日）の時点で次は JST 9時 = UTC 0時
    const now = new Date("2024-01-01T23:00:00Z"); // JST 8時
    const result = getNextCronTime("0 9 * * *", now);
    expect(result).not.toBeNull();
    // JST 9時 = UTC 0時
    expect(result?.getUTCHours()).toBe(0);
    expect(result?.getMinutes()).toBe(0);
  });

  test("無効な cron 式は null を返す", () => {
    const now = new Date("2024-01-01T08:00:00Z");
    const result = getNextCronTime("invalid cron", now);
    expect(result).toBeNull();
  });
});

describe("computeNextRunAt", () => {
  describe("once スケジュール", () => {
    test("未来時刻はそのまま返す", () => {
      const now = new Date("2024-01-01T10:00:00Z");
      const schedule: Schedule = {
        type: "once",
        executeAt: new Date("2024-01-01T12:00:00Z"),
      };

      const result = computeNextRunAt(schedule, now, null);
      expect(result).toEqual(schedule.executeAt);
    });

    test("過去時刻は null を返す", () => {
      const now = new Date("2024-01-01T12:00:00Z");
      const schedule: Schedule = {
        type: "once",
        executeAt: new Date("2024-01-01T10:00:00Z"),
      };

      const result = computeNextRunAt(schedule, now, null);
      expect(result).toBeNull();
    });

    test("同時刻は null を返す（既に実行済み扱い）", () => {
      const now = new Date("2024-01-01T10:00:00Z");
      const schedule: Schedule = {
        type: "once",
        executeAt: new Date("2024-01-01T10:00:00Z"),
      };

      const result = computeNextRunAt(schedule, now, null);
      expect(result).toBeNull();
    });
  });

  describe("interval スケジュール", () => {
    const fiveMinutes = 5 * 60 * 1000;

    test("lastRunAt から intervalMs 後を返す（未来の場合）", () => {
      const now = new Date("2024-01-01T09:58:00Z");
      const lastRunAt = new Date("2024-01-01T09:55:00Z");
      const schedule: Schedule = {
        type: "interval",
        intervalMs: fiveMinutes,
      };

      // 09:55 + 5min = 10:00 > 09:58(now) なので、10:00 を返す
      const result = computeNextRunAt(schedule, now, lastRunAt);
      expect(result).toEqual(new Date("2024-01-01T10:00:00Z"));
    });

    test("計算結果が過去または同時刻なら now + intervalMs を返す", () => {
      const now = new Date("2024-01-01T10:10:00Z");
      const lastRunAt = new Date("2024-01-01T09:55:00Z");
      const schedule: Schedule = {
        type: "interval",
        intervalMs: fiveMinutes,
      };

      // 09:55 + 5min = 10:00 <= 10:10(now) なので、now + interval = 10:15
      const result = computeNextRunAt(schedule, now, lastRunAt);
      expect(result).toEqual(new Date("2024-01-01T10:15:00Z"));
    });

    test("lastRunAt がない場合は now + intervalMs を返す", () => {
      const now = new Date("2024-01-01T10:00:00Z");
      const schedule: Schedule = {
        type: "interval",
        intervalMs: fiveMinutes,
      };

      const result = computeNextRunAt(schedule, now, null);
      expect(result).toEqual(new Date("2024-01-01T10:05:00Z"));
    });

    test("startAt が指定されている場合は startAt + intervalMs を返す", () => {
      const now = new Date("2024-01-01T10:00:00Z");
      const startAt = new Date("2024-01-01T10:02:00Z");
      const schedule: Schedule = {
        type: "interval",
        intervalMs: fiveMinutes,
        startAt,
      };

      const result = computeNextRunAt(schedule, now, null);
      expect(result).toEqual(new Date("2024-01-01T10:07:00Z"));
    });
  });

  describe("cron スケジュール", () => {
    test("次回実行時刻を返す (JST)", () => {
      // JST 8時 = UTC 23時（前日）
      const now = new Date("2024-01-01T23:00:00Z");
      const schedule: Schedule = {
        type: "cron",
        cronExpression: "0 9 * * *", // 毎日 JST 9時
      };

      const result = computeNextRunAt(schedule, now, null);
      expect(result).not.toBeNull();
      // JST 9時 = UTC 0時
      expect(result?.getUTCHours()).toBe(0);
    });

    test("無効な cron 式は null を返す", () => {
      const now = new Date("2024-01-01T08:00:00Z");
      const schedule: Schedule = {
        type: "cron",
        cronExpression: "invalid",
      };

      const result = computeNextRunAt(schedule, now, null);
      expect(result).toBeNull();
    });
  });

  describe("exponential スケジュール", () => {
    test("未来の日時を返す", () => {
      const now = new Date("2024-01-01T10:00:00Z");
      const schedule: Schedule = {
        type: "exponential",
        meanIntervalMs: 60 * 1000, // 1分平均
      };

      const result = computeNextRunAt(schedule, now, null);
      expect(result).not.toBeNull();
      expect(result?.getTime()).toBeGreaterThan(now.getTime());
    });

    test("複数回呼び出すと異なる値を返す（ランダム性）", () => {
      const now = new Date("2024-01-01T10:00:00Z");
      const schedule: Schedule = {
        type: "exponential",
        meanIntervalMs: 60 * 60 * 1000, // 1時間平均
      };

      const results = new Set<number>();
      for (let i = 0; i < 10; i++) {
        const result = computeNextRunAt(schedule, now, null);
        if (result) {
          results.add(result.getTime());
        }
      }

      // 10回呼んで全部同じ値になる確率は極めて低い
      expect(results.size).toBeGreaterThan(1);
    });
  });
});

describe("isRepeatingSchedule", () => {
  test("once は false", () => {
    const schedule: Schedule = {
      type: "once",
      executeAt: new Date(),
    };
    expect(isRepeatingSchedule(schedule)).toBe(false);
  });

  test("interval は true", () => {
    const schedule: Schedule = {
      type: "interval",
      intervalMs: 1000,
    };
    expect(isRepeatingSchedule(schedule)).toBe(true);
  });

  test("cron は true", () => {
    const schedule: Schedule = {
      type: "cron",
      cronExpression: "0 9 * * *",
    };
    expect(isRepeatingSchedule(schedule)).toBe(true);
  });

  test("exponential は true", () => {
    const schedule: Schedule = {
      type: "exponential",
      meanIntervalMs: 1000,
    };
    expect(isRepeatingSchedule(schedule)).toBe(true);
  });
});
