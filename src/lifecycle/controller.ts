/**
 * ライフサイクルコントローラー（外側ロジック）
 * 副作用を持つ処理を担当し、内側のreducerに委譲する
 */

import type { PrismaClient } from "../db/generated/prisma/client.js";
import type { Schedule, ScheduledJob } from "../scheduler/index.js";
import { isPastTime, Scheduler } from "../scheduler/index.js";
import { getLogger } from "../shared/logger.js";
import {
  defaultConfig,
  isInSleepWindow,
  type LifecycleConfig,
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

const logger = getLogger("lifecycle");

// システムジョブ名
const SYSTEM_ACTIVITY_TICK = "system:activity_tick";
const SYSTEM_PROMOTION_TICK = "system:promotion_tick";
const SYSTEM_SLEEP_START = "system:sleep_start";

/**
 * ライフサイクルコントローラー
 */
export class LifecycleController {
  private state: LifeState;
  private config: LifecycleConfig;
  private prisma: PrismaClient;
  private handler: OutputHandler;
  private scheduler: Scheduler;

  // 外側の状態
  private inSleepWindow = false;
  private sleepPending = false;
  private activityWindowStartMs: number | null = null;

  constructor(
    prisma: PrismaClient,
    handler: OutputHandler,
    config: LifecycleConfig = defaultConfig,
  ) {
    this.prisma = prisma;
    this.handler = handler;
    this.config = config;
    this.state = { mode: "OFF", focusChannelId: null };
    this.scheduler = new Scheduler(prisma);

    // スケジューラーハンドラーを登録
    this.registerSchedulerHandlers();
  }

  /**
   * スケジューラーハンドラーを登録
   */
  private registerSchedulerHandlers(): void {
    // activity_tick ハンドラー
    this.scheduler.registerHandler("activity_tick", async () => {
      await this.handleActivityTick();
    });

    // promotion_tick ハンドラー
    this.scheduler.registerHandler("promotion_tick", async () => {
      await this.handlePromotionTick();
    });

    // reminder ハンドラー
    this.scheduler.registerHandler("reminder", async (job) => {
      if (job.payload.type === "reminder") {
        const time = new Date().toLocaleTimeString("ja-JP");
        this.handler.sendToAgent(`[Reminder] ${time} ${job.payload.content}`);
      }
    });

    // sleep_start ハンドラー
    this.scheduler.registerHandler("sleep_start", async () => {
      await this.handleSleepStart();
    });
  }

  /**
   * 初期化（起動時に呼び出す）
   */
  async initialize(now: Date = new Date()): Promise<void> {
    // DBから設定を読み込み
    await this.loadConfigFromDb();

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

    // スケジューラーを初期化（DBからジョブを復元）
    await this.scheduler.initialize();

    // システムジョブの存在確認・作成
    await this.ensureSystemJobs();

    // 状態に応じてシステムジョブを有効/無効化
    await this.updateSystemJobStates();

    // 状態を保存
    await this.saveState();
  }

  /**
   * システムジョブの存在確認・作成
   */
  private async ensureSystemJobs(): Promise<void> {
    // activity_tick ジョブ
    if (!this.scheduler.findJobByName(SYSTEM_ACTIVITY_TICK)) {
      await this.scheduler.addJob({
        name: SYSTEM_ACTIVITY_TICK,
        schedule: {
          type: "interval",
          intervalMs: this.config.activityTickIntervalMs,
        },
        payload: { type: "activity_tick" },
        enabled: false, // 状態に応じて有効化
      });
    }

    // promotion_tick ジョブ
    if (!this.scheduler.findJobByName(SYSTEM_PROMOTION_TICK)) {
      await this.scheduler.addJob({
        name: SYSTEM_PROMOTION_TICK,
        schedule: {
          type: "exponential",
          meanIntervalMs: this.config.promotionMeanIntervalMs,
        },
        payload: { type: "promotion_tick" },
        enabled: false, // 状態に応じて有効化
      });
    }

    // sleep_start ジョブ（sleepStartTime に毎日発火）
    if (!this.scheduler.findJobByName(SYSTEM_SLEEP_START)) {
      const [hours, minutes] = this.config.sleepStartTime
        .split(":")
        .map(Number);
      await this.scheduler.addJob({
        name: SYSTEM_SLEEP_START,
        schedule: {
          type: "cron",
          cronExpression: `${minutes} ${hours} * * *`,
        },
        payload: { type: "sleep_start" },
        enabled: true,
      });
    }
  }

  /**
   * 状態に応じてシステムジョブを有効/無効化
   */
  private async updateSystemJobStates(): Promise<void> {
    const isWatching = this.state.mode === "AWAKE_WATCHING";
    const isNotWatching = this.state.mode === "AWAKE_NOT_WATCHING";

    // activity_tick: WATCHING 時のみ有効
    const activityJob = this.scheduler.findJobByName(SYSTEM_ACTIVITY_TICK);
    if (activityJob) {
      const shouldEnable = isWatching;
      if (activityJob.enabled !== shouldEnable) {
        await this.scheduler.setJobEnabled(activityJob.id, shouldEnable);
        if (shouldEnable) {
          this.activityWindowStartMs = Date.now();
        }
      }
    }

    // promotion_tick: NOT_WATCHING かつ非睡眠時間帯のみ有効
    const promotionJob = this.scheduler.findJobByName(SYSTEM_PROMOTION_TICK);
    if (promotionJob) {
      const shouldEnable = isNotWatching && !this.inSleepWindow;
      if (promotionJob.enabled !== shouldEnable) {
        await this.scheduler.setJobEnabled(promotionJob.id, shouldEnable);
      }
    }
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
    const chId = toChannelId(channelId);

    // reducerにイベントを送信
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

    // WATCHING開始時に未読サマリーを送る（メンション/リプライで起こされた時）
    if (
      prevMode !== "AWAKE_WATCHING" &&
      this.state.mode === "AWAKE_WATCHING" &&
      isMentionOrReplyToAgent
    ) {
      const time = new Date().toLocaleTimeString("ja-JP");
      this.handler.sendToAgent(
        `[Lifecycle] ${time} AWAKE_WATCHING に遷移しました。(focus: ${chId})`,
      );

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

    // 状態遷移があった場合はシステムジョブを更新
    if (prevMode !== this.state.mode) {
      await this.updateSystemJobStates();
    }

    // WATCHING終了後に睡眠保留の処理
    this.handleSleepPendingIfNeeded();

    await this.saveState();
  }

  /**
   * AIツールから SET_NOT_WATCHING を受けた時
   */
  async setNotWatching(): Promise<void> {
    const prevMode = this.state.mode;
    this.dispatch({ type: "SET_NOT_WATCHING" });
    this.handleSleepPendingIfNeeded();
    await this.saveState();

    if (prevMode !== this.state.mode) {
      await this.updateSystemJobStates();
    }
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
   * スケジューラーを取得（テスト用）
   */
  getScheduler(): Scheduler {
    return this.scheduler;
  }

  // ============================================================
  // リマインダー API
  // ============================================================

  /**
   * リマインダーを作成
   */
  async createReminder(
    content: string,
    schedule:
      | { type: "once"; executeAt: Date }
      | { type: "cron"; cronExpression: string },
  ): Promise<ScheduledJob> {
    // 過去時刻チェック（once の場合）
    if (
      schedule.type === "once" &&
      isPastTime(schedule.executeAt, new Date())
    ) {
      throw new Error("過去の時刻にはリマインダーを設定できません");
    }

    return this.scheduler.addJob({
      name: `reminder:${Date.now()}`,
      schedule: schedule as Schedule,
      payload: { type: "reminder", content },
      enabled: true,
    });
  }

  /**
   * リマインダー一覧を取得
   */
  listReminders(): ScheduledJob[] {
    return this.scheduler
      .listJobs()
      .filter((job) => job.payload.type === "reminder" && job.enabled);
  }

  /**
   * リマインダーを削除
   */
  async deleteReminder(jobId: string): Promise<boolean> {
    const job = this.scheduler.listJobs().find((j) => j.id === jobId);
    if (!job || job.payload.type !== "reminder") {
      return false;
    }
    return this.scheduler.removeJob(jobId);
  }

  /**
   * 現在の設定を取得
   */
  getConfig(): LifecycleConfig {
    return { ...this.config };
  }

  /**
   * 設定を更新（DBに永続化し、システムジョブを再作成）
   */
  async updateConfig(
    partial: Partial<LifecycleConfig>,
  ): Promise<LifecycleConfig> {
    const newConfig = { ...this.config, ...partial };
    this.config = newConfig;

    // DBに永続化
    await this.prisma.lifecycleConfig.upsert({
      where: { id: "singleton" },
      update: {
        sleepStartTime: newConfig.sleepStartTime,
        sleepEndTime: newConfig.sleepEndTime,
        promotionMeanIntervalMs: newConfig.promotionMeanIntervalMs,
        activityTickIntervalMs: newConfig.activityTickIntervalMs,
      },
      create: {
        id: "singleton",
        sleepStartTime: newConfig.sleepStartTime,
        sleepEndTime: newConfig.sleepEndTime,
        promotionMeanIntervalMs: newConfig.promotionMeanIntervalMs,
        activityTickIntervalMs: newConfig.activityTickIntervalMs,
      },
    });

    // システムジョブを再作成
    await this.recreateSystemJobs();

    // 睡眠時間帯を再判定
    this.inSleepWindow = isInSleepWindow(new Date(), this.config);

    return { ...this.config };
  }

  /**
   * エージェントにメッセージを送信
   */
  sendToAgent(message: string): void {
    this.handler.sendToAgent(message);
  }

  /**
   * クリーンアップ
   */
  cleanup(): void {
    this.scheduler.cleanup();
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
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
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
        return;
      } catch (error) {
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
        } else {
          // saveStateの失敗はメッセージ送信をブロックしない
          console.warn(
            "[LifecycleController] saveState failed after retries (non-fatal):",
            error,
          );
        }
      }
    }
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

  private async loadConfigFromDb(): Promise<void> {
    const saved = await this.prisma.lifecycleConfig.findUnique({
      where: { id: "singleton" },
    });
    if (saved) {
      this.config = {
        sleepStartTime: saved.sleepStartTime,
        sleepEndTime: saved.sleepEndTime,
        promotionMeanIntervalMs: saved.promotionMeanIntervalMs,
        activityTickIntervalMs: saved.activityTickIntervalMs,
      };
      logger.info(
        `[Lifecycle] Config loaded from DB: sleep=${saved.sleepStartTime}-${saved.sleepEndTime}`,
      );
    }
  }

  private async recreateSystemJobs(): Promise<void> {
    for (const name of [
      SYSTEM_ACTIVITY_TICK,
      SYSTEM_PROMOTION_TICK,
      SYSTEM_SLEEP_START,
    ]) {
      const job = this.scheduler.findJobByName(name);
      if (job) {
        await this.scheduler.removeJob(job.id);
      }
    }
    await this.ensureSystemJobs();
    await this.updateSystemJobStates();
  }

  private async handleSleepStart(): Promise<void> {
    if (this.state.mode === "OFF") return;

    const today = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Tokyo",
    }).format(new Date());

    const sleepMessage =
      `[Sleep] 睡眠時の記憶整理を行ってください。` +
      ` 1. 日次ドキュメントの作成: docs/daily/${today}.md に今日の出来事を記述する` +
      `（今日の出来事・会話の要点を詳細に記述、学んだこと・改善すべき点、` +
      `今後も参照しそうな知識は docs/ 以下に独立したドキュメントとして作成し日次ドキュメントからリンクする）` +
      ` 2. CLAUDE.md の見直し: 今日の経験を踏まえて行動ルールを改善すべき箇所があれば更新。` +
      `「## 参照ドキュメント」セクションの番号付きリストを最重要なもの最大10件に維持` +
      `（不要リンクは外し、新たに重要なものがあれば入れ替え。` +
      `リストにないドキュメントは必要時に docs/ 内を検索して参照）` +
      ` 3. verify_memory_links を実行し、問題があれば修正してから再実行する。`;

    this.handler.sendToAgent(sleepMessage);

    this.inSleepWindow = true;

    if (this.state.mode === "AWAKE_NOT_WATCHING") {
      this.dispatch({ type: "SLEEP" });
      await this.updateSystemJobStates();
      await this.saveState();
    } else if (this.state.mode === "AWAKE_WATCHING") {
      this.sleepPending = true;
    }
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

    // 昇格通知を送信
    const time = new Date().toLocaleTimeString("ja-JP");
    this.handler.sendToAgent(
      `[Lifecycle] ${time} AWAKE_WATCHING に昇格しました。行動を開始してください。(focus: ${focusChannelId})`,
    );

    // 未読サマリーを送信（未読がある場合のみ）
    const summary = formatUnreadSummary(summaries);
    if (summary) {
      this.handler.sendToAgent(summary);
    }

    // システムジョブの状態を更新（activity_tick を有効化）
    await this.updateSystemJobStates();

    await this.saveState();
  }

  private async handleActivityTick(): Promise<void> {
    if (this.state.mode !== "AWAKE_WATCHING") {
      return;
    }

    const nowMs = Date.now();

    // 全未読を取得し、UnreadSummaryWithDetails に変換
    const rawSummary = await getUnreadSummary(this.prisma);
    const summary: UnreadSummaryWithDetails[] = rawSummary.map((s) => ({
      channelId: s.channelId,
      guildId: s.guildId,
      unreadCount: s.unreadCount,
      messages: [],
    }));

    this.dispatch({
      type: "ACTIVITY_TICK",
      windowStartMs: toUnixMs(this.activityWindowStartMs ?? nowMs),
      windowEndMs: toUnixMs(nowMs),
      summary,
    });

    // 次のウィンドウ開始
    this.activityWindowStartMs = nowMs;
  }
}
