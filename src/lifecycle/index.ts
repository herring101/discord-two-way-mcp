/**
 * lifecycle モジュールのエクスポート
 */

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
  UserId,
} from "./types.js";
export {
  toChannelId,
  toMessageId,
  toUnixMs,
  toUserId,
} from "./types.js";
export {
  formatUnreadSummary,
  getUnreadCount,
  getUnreadSummary,
  incrementUnread,
  markAsRead,
  type UnreadSummary,
} from "./unread.js";
