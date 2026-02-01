/**
 * lifecycle モジュールのエクスポート
 */

// スケジューラー関連の再エクスポート
export type { Schedule, ScheduledJob } from "../scheduler/index.js";
export {
  defaultConfig,
  isInSleepWindow,
  type LifecycleConfig,
} from "./config.js";
export { LifecycleController, type OutputHandler } from "./controller.js";
export { reduce } from "./reducer.js";
export type {
  AgentMode,
  ChannelId,
  LifeEvent,
  LifeOutput,
  LifeState,
  MessageId,
  ReduceResult,
  UnreadDetail,
  UnreadSummaryWithDetails,
  UserId,
} from "./types.js";
export {
  toChannelId,
  toMessageId,
  toUnixMs,
  toUserId,
} from "./types.js";
export {
  addUnreadMessage,
  formatUnreadSummary,
  getRecentUnreadMessages,
  getUnreadSummary,
  markAsRead,
  type UnreadSummary,
} from "./unread.js";
