/**
 * ライフサイクルコントローラー（外側ロジック）
 * 副作用を持つ処理を担当し、内側のreducerに委譲する
 */

import type { PrismaClient } from "../db/generated/prisma/client.js";
import {
  defaultConfig,
  isInSleepWindow,
  type LifecycleConfig,
  sampleExponential,
} from "./config.js";
import { reduce } from "./reducer.js";
import type {
  AgentMode,
  ChannelId,
  LifeEvent,
  LifeOutput,
  LifeState,
  MessageId,
  UnreadSummaryWithDetails,
  UserId,
} from "./types.js";
import { toChannelId, toUnixMs } from "./types.js";
import {
  addUnreadMessage,
  formatUnreadSummary,
  getRecentUnreadMessages,
  getUnreadSummary,
  markAsRead,
} from "./unread.js";

/**
 * 出力ハンドラの型
 */
export interface OutputHandler {
  onWatchingStarted: (focusChannelId: ChannelId) => void;
  onWatchingEnded: () => void;
  onFocusMessage: (channelId: ChannelId, messageId: MessageId) => void;
  onActivityDigest: (
    windowStartMs: number,
    windowEndMs: number,
    summary: UnreadSummaryWithDetails[],
  ) => void;
  sendToAgent: (message: string) => void;
}

/**
 * ライフサイクルコントローラー
 */
export class LifecycleController {
  private state: LifeState;
  private config: LifecycleConfig;
  private prisma: PrismaClient;
  private handler: OutputHandler;

  // 外側の状態
  private inSleepWindow = false;
  private sleepPending = false;
  private nextActivityTickAt: number | null = null;
  private activityWindowStartMs: number | null = null;

  // タイマー
  private promotionTimer: ReturnType<typeof setTimeout> | null = null;
  private activityTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    prisma: PrismaClient,
    handler: OutputHandler,
    config: LifecycleConfig = defaultConfig,
  ) {
    this.prisma = prisma;
    this.handler = handler;
    this.config = config;
    this.state = { mode: "OFF", focusChannelId: null };
  }

  /**
   * 初期化（起動時に呼び出す）
   */
  async initialize(now: Date = new Date()): Promise<void> {
    // DBから状態を復元
    const saved = await this.prisma.agentState.findUnique({
      where: { id: "singleton" },
    });

    if (saved) {
      this.state = {
        mode: saved.mode as AgentMode,
        focusChannelId: saved.focusChannelId
          ? toChannelId(saved.focusChannelId)
          : null,
      };
    }

    // 睡眠時間帯の判定
    this.inSleepWindow = isInSleepWindow(now, this.config);

    // 初期状態の決定
    if (this.state.mode === "OFF" && !this.inSleepWindow) {
      // 起床時間帯なのにOFFなら起こす
      this.dispatch({ type: "WAKE" });
    } else if (this.state.mode !== "OFF" && this.inSleepWindow) {
      // 睡眠時間帯なのに起きてるなら状態に応じて処理
      if (this.state.mode === "AWAKE_NOT_WATCHING") {
        this.dispatch({ type: "SLEEP" });
      } else {
        // WATCHINGなら保留
        this.sleepPending = true;
      }
    }

    // 確率昇格のスケジュール
    this.schedulePromotionIfNeeded();

    // 状態を保存
    await this.saveState();
  }

  /**
   * Discordメッセージ受信時
   */
  async onDiscordMessage(
    channelId: string,
    messageId: string,
    authorId: string,
    guildId: string,
    isMentionOrReplyToAgent: boolean,
  ): Promise<void> {
    const now = Date.now();
    const chId = toChannelId(channelId);

    // reducerにイベントを送信
    // 注意: 未読判定には状態遷移後の focusChannelId が必要なので、
    // 先に dispatch してから判定を行う
    const event: LifeEvent = {
      type: "DISCORD_MESSAGE",
      channelId: chId,
      messageId: messageId as MessageId,
      authorId: authorId as UserId,
      isMentionOrReplyToAgent,
    };

    const prevMode = this.state.mode;
    this.dispatch(event);

    // 未読メッセージを追加（focus channel以外、またはWATCHINGでない場合）
    // メンション/リプライは即座に既読になるので追加しない
    const isFocusChannel =
      this.state.mode === "AWAKE_WATCHING" &&
      this.state.focusChannelId === chId;

    if (!isFocusChannel && !isMentionOrReplyToAgent) {
      await addUnreadMessage(
        this.prisma,
        chId,
        messageId as MessageId,
        guildId,
      );
    }

    // WATCHING開始時に未読サマリーを送る（確率昇格時と同様）
    if (
      prevMode !== "AWAKE_WATCHING" &&
      this.state.mode === "AWAKE_WATCHING" &&
      isMentionOrReplyToAgent
    ) {
      const summaries = await getUnreadSummary(this.prisma);
      const summary = formatUnreadSummary(summaries);
      if (summary) {
        this.handler.sendToAgent(summary);
      }
    }

    // メンション/リプライまたはfocusChannelなら既読化
    if (isMentionOrReplyToAgent || isFocusChannel) {
      await markAsRead(this.prisma, chId, messageId as MessageId);
    }

    // 5分集計のタイマー開始
    if (this.state.mode === "AWAKE_WATCHING") {
      this.scheduleActivityTickIfNeeded(now);
    }

    // WATCHING終了後に睡眠保留の処理
    this.handleSleepPendingIfNeeded();

    await this.saveState();
  }

  /**
   * AIツールから SET_NOT_WATCHING を受けた時
   */
  async setNotWatching(): Promise<void> {
    this.dispatch({ type: "SET_NOT_WATCHING" });
    this.handleSleepPendingIfNeeded();
    await this.saveState();
    this.schedulePromotionIfNeeded();
  }

  /**
   * AIツールから SET_FOCUS_CHANNEL を受けた時
   */
  async setFocusChannel(channelId: string): Promise<void> {
    this.dispatch({
      type: "SET_FOCUS_CHANNEL",
      channelId: toChannelId(channelId),
    });
    await this.saveState();
  }

  /**
   * get_channel_messages 時に呼び出す（既読化）
   */
  async onChannelMessagesRead(
    channelId: string,
    latestMessageId: string,
  ): Promise<void> {
    await markAsRead(
      this.prisma,
      toChannelId(channelId),
      latestMessageId as MessageId,
    );
  }

  /**
   * 現在の状態を取得
   */
  getState(): LifeState {
    return { ...this.state };
  }

  /**
   * クリーンアップ
   */
  cleanup(): void {
    if (this.promotionTimer) {
      clearTimeout(this.promotionTimer);
      this.promotionTimer = null;
    }
    if (this.activityTimer) {
      clearTimeout(this.activityTimer);
      this.activityTimer = null;
    }
  }

  // ============================================================
  // Private methods
  // ============================================================

  private dispatch(event: LifeEvent): void {
    const result = reduce(this.state, event);
    this.state = result.state;
    this.handleOutputs(result.outputs);
  }

  private handleOutputs(outputs: LifeOutput[]): void {
    for (const output of outputs) {
      switch (output.type) {
        case "WATCHING_STARTED":
          this.handler.onWatchingStarted(output.focusChannelId);
          break;
        case "WATCHING_ENDED":
          this.handler.onWatchingEnded();
          break;
        case "FOCUS_MESSAGE":
          this.handler.onFocusMessage(output.channelId, output.messageId);
          break;
        case "ACTIVITY_DIGEST":
          this.handler.onActivityDigest(
            output.windowStartMs,
            output.windowEndMs,
            output.summary,
          );
          break;
        case "NOOP":
          break;
      }
    }
  }

  private async saveState(): Promise<void> {
    await this.prisma.agentState.upsert({
      where: { id: "singleton" },
      update: {
        mode: this.state.mode,
        focusChannelId: this.state.focusChannelId,
        lastWakeAt: this.state.mode !== "OFF" ? new Date() : undefined,
        lastSleepAt: this.state.mode === "OFF" ? new Date() : undefined,
      },
      create: {
        id: "singleton",
        mode: this.state.mode,
        focusChannelId: this.state.focusChannelId,
      },
    });
  }

  private handleSleepPendingIfNeeded(): void {
    if (
      this.sleepPending &&
      this.inSleepWindow &&
      this.state.mode === "AWAKE_NOT_WATCHING"
    ) {
      this.dispatch({ type: "SLEEP" });
      this.sleepPending = false;
    }
  }

  private schedulePromotionIfNeeded(): void {
    // 既存のタイマーをクリア
    if (this.promotionTimer) {
      clearTimeout(this.promotionTimer);
      this.promotionTimer = null;
    }

    // 睡眠時間帯または NOT_WATCHING 以外はスケジュールしない
    if (this.inSleepWindow || this.state.mode !== "AWAKE_NOT_WATCHING") {
      return;
    }

    // 指数分布でサンプリング
    const delayMs = sampleExponential(this.config.promotionMeanIntervalMs);

    this.promotionTimer = setTimeout(() => {
      this.handlePromotionTick();
    }, delayMs);
  }

  private async handlePromotionTick(): Promise<void> {
    if (this.state.mode !== "AWAKE_NOT_WATCHING") {
      return;
    }

    // 未読サマリーを取得してfocusChannelを決定
    const summaries = await getUnreadSummary(this.prisma);
    const firstSummary = summaries[0];
    const focusChannelId = firstSummary
      ? toChannelId(firstSummary.channelId)
      : toChannelId("default"); // フォールバック

    // 昇格
    this.dispatch({
      type: "PROMOTE_TO_WATCHING",
      focusChannelId,
    });

    // 未読サマリーを送信（未読がある場合のみ）
    const summary = formatUnreadSummary(summaries);
    if (summary) {
      this.handler.sendToAgent(summary);
    }

    await this.saveState();
  }

  private scheduleActivityTickIfNeeded(nowMs: number): void {
    if (this.state.mode !== "AWAKE_WATCHING") {
      this.activityWindowStartMs = null;
      this.nextActivityTickAt = null;
      if (this.activityTimer) {
        clearTimeout(this.activityTimer);
        this.activityTimer = null;
      }
      return;
    }

    if (this.nextActivityTickAt !== null) {
      return; // 既にスケジュール済み
    }

    this.activityWindowStartMs = nowMs;
    this.nextActivityTickAt = nowMs + this.config.activityTickIntervalMs;

    this.activityTimer = setTimeout(() => {
      this.handleActivityTick();
    }, this.config.activityTickIntervalMs);
  }

  private async handleActivityTick(): Promise<void> {
    if (this.state.mode !== "AWAKE_WATCHING") {
      return;
    }

    const nowMs = Date.now();
    const durationMinutes =
      (nowMs - (this.activityWindowStartMs ?? nowMs)) / 1000 / 60;
    // 少なくとも5分間、あるいはウィンドウ開始からの未読を取得
    // 念の為少し余裕を持たせる（5分 -> 6分とか）
    const summary = await getRecentUnreadMessages(
      this.prisma,
      Math.max(5, Math.ceil(durationMinutes)),
    );

    this.dispatch({
      type: "ACTIVITY_TICK",
      windowStartMs: toUnixMs(this.activityWindowStartMs ?? nowMs),
      windowEndMs: toUnixMs(nowMs),
      summary,
    });

    // 次のウィンドウ
    this.activityWindowStartMs = nowMs;
    this.nextActivityTickAt = nowMs + this.config.activityTickIntervalMs;

    this.activityTimer = setTimeout(() => {
      this.handleActivityTick();
    }, this.config.activityTickIntervalMs);
  }
}
