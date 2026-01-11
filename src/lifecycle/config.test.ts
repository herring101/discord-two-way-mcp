/**
 * 設定のテスト
 */

import { describe, expect, test } from "bun:test";
import {
  defaultConfig,
  isInSleepWindow,
  timeStringToMinutes,
} from "./config.js";

describe("timeStringToMinutes", () => {
  test("00:00 → 0", () => {
    expect(timeStringToMinutes("00:00")).toBe(0);
  });

  test("02:30 → 150", () => {
    expect(timeStringToMinutes("02:30")).toBe(150);
  });

  test("10:30 → 630", () => {
    expect(timeStringToMinutes("10:30")).toBe(630);
  });

  test("23:59 → 1439", () => {
    expect(timeStringToMinutes("23:59")).toBe(1439);
  });
});

describe("isInSleepWindow", () => {
  const config = defaultConfig; // 02:30 ~ 10:30

  test("03:00 は睡眠時間帯", () => {
    const date = new Date("2026-01-11T03:00:00");
    expect(isInSleepWindow(date, config)).toBe(true);
  });

  test("02:30 は睡眠時間帯（開始時刻）", () => {
    const date = new Date("2026-01-11T02:30:00");
    expect(isInSleepWindow(date, config)).toBe(true);
  });

  test("10:29 は睡眠時間帯", () => {
    const date = new Date("2026-01-11T10:29:00");
    expect(isInSleepWindow(date, config)).toBe(true);
  });

  test("10:30 は睡眠時間帯ではない（終了時刻）", () => {
    const date = new Date("2026-01-11T10:30:00");
    expect(isInSleepWindow(date, config)).toBe(false);
  });

  test("12:00 は睡眠時間帯ではない", () => {
    const date = new Date("2026-01-11T12:00:00");
    expect(isInSleepWindow(date, config)).toBe(false);
  });

  test("02:00 は睡眠時間帯ではない", () => {
    const date = new Date("2026-01-11T02:00:00");
    expect(isInSleepWindow(date, config)).toBe(false);
  });

  test("日をまたぐ設定 (22:00 ~ 06:00)", () => {
    const nightConfig = {
      ...config,
      sleepStartTime: "22:00",
      sleepEndTime: "06:00",
    };

    // 23:00 は睡眠時間帯
    expect(isInSleepWindow(new Date("2026-01-11T23:00:00"), nightConfig)).toBe(
      true,
    );

    // 03:00 は睡眠時間帯
    expect(isInSleepWindow(new Date("2026-01-11T03:00:00"), nightConfig)).toBe(
      true,
    );

    // 12:00 は睡眠時間帯ではない
    expect(isInSleepWindow(new Date("2026-01-11T12:00:00"), nightConfig)).toBe(
      false,
    );

    // 06:00 は睡眠時間帯ではない（終了時刻）
    expect(isInSleepWindow(new Date("2026-01-11T06:00:00"), nightConfig)).toBe(
      false,
    );
  });
});
