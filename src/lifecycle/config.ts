/**
 * ライフサイクル設定
 */

export interface LifecycleConfig {
  /** 睡眠時間帯の開始（時:分形式、例: "02:30"） */
  sleepStartTime: string;

  /** 睡眠時間帯の終了（時:分形式、例: "10:30"） */
  sleepEndTime: string;

  /** 確率昇格の平均間隔（ミリ秒） */
  promotionMeanIntervalMs: number;

  /** 5分集計の間隔（ミリ秒） */
  activityTickIntervalMs: number;
}

/**
 * デフォルト設定
 */
export const defaultConfig: LifecycleConfig = {
  sleepStartTime: "02:30",
  sleepEndTime: "10:30",
  promotionMeanIntervalMs: 2 * 60 * 60 * 1000, // 2時間
  activityTickIntervalMs: 5 * 60 * 1000, // 5分
};

/**
 * 時刻文字列を分に変換（00:00からの経過分）
 */
export function timeStringToMinutes(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

/**
 * 現在時刻が睡眠時間帯かどうかを判定
 */
export function isInSleepWindow(now: Date, config: LifecycleConfig): boolean {
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const sleepStart = timeStringToMinutes(config.sleepStartTime);
  const sleepEnd = timeStringToMinutes(config.sleepEndTime);

  // 日をまたぐ場合（例: 02:30 ~ 10:30 → 02:30 以降 OR 10:30 以前）
  if (sleepStart > sleepEnd) {
    return currentMinutes >= sleepStart || currentMinutes < sleepEnd;
  }

  // 日をまたがない場合
  return currentMinutes >= sleepStart && currentMinutes < sleepEnd;
}

/**
 * 指数分布からサンプリング（確率昇格用）
 * 平均 meanMs ミリ秒の指数分布に従う待機時間を返す
 */
export function sampleExponential(meanMs: number): number {
  const u = Math.random(); // 0 < u < 1
  // ln(1-u) ではなく ln(u) でも同じ分布（1-u も一様分布）
  return -Math.log(u) * meanMs;
}
