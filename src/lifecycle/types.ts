/**
 * エージェントライフサイクル管理の型定義
 */

// ============================================================
// Branded Types（型安全性のため）
// ============================================================

type Brand<K, T> = K & { readonly __brand: T };

export type ChannelId = Brand<string, "ChannelId">;
export type MessageId = Brand<string, "MessageId">;
export type UserId = Brand<string, "UserId">;
export type UnixMs = Brand<number, "UnixMs">;

// 型変換ヘルパー
export const toChannelId = (s: string): ChannelId => s as ChannelId;
export const toMessageId = (s: string): MessageId => s as MessageId;
export const toUserId = (s: string): UserId => s as UserId;
export const toUnixMs = (n: number): UnixMs => n as UnixMs;

// ============================================================
// エージェントモード
// ============================================================

/**
 * OFF: 睡眠時間帯。自発的には動かないが、メンション/リプライで起きる
 * AWAKE_NOT_WATCHING: 活動時間帯だが見ていない。確率で昇格する
 * AWAKE_WATCHING: アクティブに見ている。focusChannelのメッセージを受け取る
 */
export type AgentMode = "OFF" | "AWAKE_NOT_WATCHING" | "AWAKE_WATCHING";

// ============================================================
// 内側の状態（reducer が管理）
// ============================================================

export interface LifeState {
  mode: AgentMode;
  focusChannelId: ChannelId | null;
}

export const initialLifeState: LifeState = {
  mode: "OFF",
  focusChannelId: null,
};

// ============================================================
// イベント（外側から内側に投げる）
// ============================================================

export interface UnreadDetail {
  messageId: string;
  authorUsername: string;
  content: string;
  createdAt: Date;
}

export interface UnreadSummaryWithDetails {
  channelId: string;
  guildId: string;
  unreadCount: number;
  messages: UnreadDetail[];
}

export type LifeEvent =
  | { type: "WAKE" }
  | { type: "SLEEP" }
  | {
      type: "DISCORD_MESSAGE";
      channelId: ChannelId;
      messageId: MessageId;
      authorId: UserId;
      isMentionOrReplyToAgent: boolean;
    }
  | {
      type: "PROMOTE_TO_WATCHING";
      focusChannelId: ChannelId;
    }
  | { type: "SET_NOT_WATCHING" }
  | { type: "SET_FOCUS_CHANNEL"; channelId: ChannelId }
  | {
      type: "ACTIVITY_TICK";
      windowStartMs: UnixMs;
      windowEndMs: UnixMs;
      summary: UnreadSummaryWithDetails[];
    };

// ============================================================
// 出力（内側から外側に返す）
// ============================================================

export type LifeOutput =
  | { type: "NOOP" }
  | { type: "WATCHING_STARTED"; focusChannelId: ChannelId }
  | { type: "WATCHING_ENDED" }
  | { type: "FOCUS_MESSAGE"; channelId: ChannelId; messageId: MessageId }
  | {
      type: "ACTIVITY_DIGEST";
      windowStartMs: UnixMs;
      windowEndMs: UnixMs;
      summary: UnreadSummaryWithDetails[];
    };

// ============================================================
// Reducer の結果
// ============================================================

export interface ReduceResult {
  state: LifeState;
  outputs: LifeOutput[];
}
