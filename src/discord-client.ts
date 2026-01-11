import {
  Client,
  DMChannel,
  Events,
  GatewayIntentBits,
  type Interaction,
  type Message,
} from "discord.js";
import {
  type ChannelId,
  defaultConfig,
  LifecycleController,
  type MessageId,
  type OutputHandler,
} from "./lifecycle/index.js";
import { handleSlashCommand, registerSlashCommands } from "./slash-commands.js";
import {
  disconnectDatabase,
  getPrismaClient,
  initDatabase,
  saveMessage,
} from "./utils/database.js";
import {
  type FormattableMessage,
  formatDateSeparator,
  formatMessage,
  isSameDay,
} from "./utils/format.js";
import { importAllGuildsAsync } from "./utils/import.js";
import { getTmuxSession, sendToTmux } from "./utils/tmux.js";

// グローバルコントローラーインスタンス（ツールからアクセス用）
let lifecycleController: LifecycleController | null = null;

export function getLifecycleController(): LifecycleController | null {
  return lifecycleController;
}

export class DiscordClient {
  private client: Client;
  private _isReady = false;
  private tmuxSession: string | null = null;
  private lastNotifiedDate: Date | null = null;
  private controller: LifecycleController | null = null;

  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    // tmuxセッションを検出
    this.tmuxSession = getTmuxSession();
    if (!this.tmuxSession) {
      console.error("⚠️ Warning: tmuxセッションが検出されませんでした。");
    } else {
      console.error(`tmux session detected: ${this.tmuxSession}`);
    }

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.client.once("clientReady", async () => {
      console.error(`Discord bot logged in as ${this.client.user?.tag}`);

      if (this.client.user) {
        try {
          const { isNewDatabase } = await initDatabase(this.client.user.id);
          console.error(`Database initialized for bot ${this.client.user.id}`);

          // LifecycleController を初期化
          this.initializeLifecycleController();

          // スラッシュコマンドを登録
          const token = process.env.DISCORD_BOT_TOKEN;
          if (token) {
            registerSlashCommands(this.client, token).catch((error) => {
              console.error("Failed to register slash commands:", error);
            });
          }

          if (isNewDatabase) {
            console.error(
              "[Import] New database detected, starting initial import...",
            );
            importAllGuildsAsync(this.client);
          }
        } catch (error) {
          console.error("Failed to initialize database:", error);
        }
      }

      this._isReady = true;
    });

    this.client.on("error", (error) => {
      console.error("Discord error:", error);
    });

    this.client.on("messageCreate", (message: Message) => {
      this.handleMessage(message);
    });

    // スラッシュコマンドのハンドリング
    this.client.on(Events.InteractionCreate, (interaction: Interaction) => {
      if (interaction.isChatInputCommand()) {
        handleSlashCommand(interaction).catch((error) => {
          console.error("Failed to handle slash command:", error);
        });
      }
    });
  }

  private initializeLifecycleController(): void {
    const prisma = getPrismaClient();

    // OutputHandler の実装
    const handler: OutputHandler = {
      onWatchingStarted: (focusChannelId: ChannelId) => {
        console.error(`[Lifecycle] WATCHING started: focus=${focusChannelId}`);
      },
      onWatchingEnded: () => {
        console.error("[Lifecycle] WATCHING ended");
      },
      onFocusMessage: (channelId: ChannelId, messageId: MessageId) => {
        // このメッセージはtmuxに送信される（後で実装）
        console.error(
          `[Lifecycle] Focus message: ch=${channelId}, msg=${messageId}`,
        );
      },
      onActivityDigest: (
        windowStartMs: number,
        windowEndMs: number,
        counts: Record<string, number>,
      ) => {
        if (!this.tmuxSession) return;
        const duration = Math.round((windowEndMs - windowStartMs) / 1000 / 60);
        const totalCount = Object.values(counts).reduce((a, b) => a + b, 0);
        const summary = `[Activity] 過去${duration}分: ${totalCount}件のメッセージ`;
        sendToTmux(this.tmuxSession, summary);
      },
      sendToAgent: (message: string) => {
        if (!this.tmuxSession) return;
        sendToTmux(this.tmuxSession, message);
      },
    };

    this.controller = new LifecycleController(prisma, handler, defaultConfig);
    lifecycleController = this.controller;

    // 初期化（起動時刻で状態を決定）
    this.controller.initialize().catch((error) => {
      console.error("Failed to initialize lifecycle controller:", error);
    });

    console.error("[Lifecycle] Controller initialized");
  }

  private handleMessage(message: Message): void {
    // 自分自身（Bot）のメッセージは無視
    if (message.author.id === this.client.user?.id) return;

    // メッセージをDBに保存
    saveMessage(message).catch((error) => {
      console.error("Failed to save message to DB:", error);
    });

    console.error(
      `[MSG] ${message.author.tag}: ${message.content.slice(0, 50)}${message.content.length > 50 ? "..." : ""}`,
    );

    // メンション/リプライ判定
    const isMentionOrReplyToAgent = this.checkMentionOrReply(message);

    // ライフサイクルコントローラーにイベントを送信
    if (this.controller) {
      const guildId = message.guild?.id ?? "DM";
      this.controller
        .onDiscordMessage(
          message.channelId,
          message.id,
          message.author.id,
          guildId,
          isMentionOrReplyToAgent,
        )
        .then(() => {
          // コントローラーの状態に応じて通知
          const state = this.controller?.getState();
          if (state?.mode === "AWAKE_WATCHING") {
            // focusChannel のメッセージ、またはメンション/リプライなら通知
            if (
              state.focusChannelId === message.channelId ||
              isMentionOrReplyToAgent
            ) {
              this.notifyTmux(message);
            }
          } else if (isMentionOrReplyToAgent) {
            // WATCHING以外でもメンション/リプライは通知
            this.notifyTmux(message);
          }
        })
        .catch((error) => {
          console.error("Failed to process message in lifecycle:", error);
        });
    } else {
      // コントローラーがない場合は従来通り全て通知
      this.notifyTmux(message);
    }
  }

  private checkMentionOrReply(message: Message): boolean {
    const botUser = this.client.user;
    if (!botUser) return false;

    // メンションされているか
    if (message.mentions.users.has(botUser.id)) {
      return true;
    }

    // リプライかどうか（リプライ先のauthorがBot）
    if (message.reference?.messageId) {
      // リプライ先のメッセージを取得するのは非同期なので、
      // ここでは mentions に含まれるかで判定する
      // Discord.js は reply で自動的に mentions に追加される
      return message.mentions.repliedUser?.id === botUser.id;
    }

    return false;
  }

  private notifyTmux(message: Message): void {
    if (!this.tmuxSession) return;

    // チャンネル名を取得
    const channelName =
      message.channel instanceof DMChannel
        ? null
        : "name" in message.channel
          ? (message.channel.name as string)
          : null;

    // FormattableMessage に変換
    const formattable: FormattableMessage = {
      id: message.id,
      channelId: message.channelId,
      channelName,
      author: {
        id: message.author.id,
        username: message.author.username,
        displayName: message.member?.displayName ?? message.author.username,
      },
      content: message.content,
      timestamp: message.createdAt,
      attachments: message.attachments.map((att) => ({
        filename: att.name ?? "unknown",
      })),
    };

    // 日付セパレータの処理
    if (
      !this.lastNotifiedDate ||
      !isSameDay(this.lastNotifiedDate, message.createdAt)
    ) {
      sendToTmux(this.tmuxSession, formatDateSeparator(message.createdAt));
    }
    this.lastNotifiedDate = message.createdAt;

    // メッセージ本体を送信
    const notification = formatMessage(formattable);
    sendToTmux(this.tmuxSession, notification);
  }

  async connect(): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
      throw new Error("DISCORD_BOT_TOKEN environment variable is required");
    }
    console.error("Connecting to Discord...");
    await this.client.login(token);
  }

  async disconnect(): Promise<void> {
    if (this.controller) {
      this.controller.cleanup();
    }
    await disconnectDatabase();
    await this.client.destroy();
  }

  get isReady(): boolean {
    return this._isReady;
  }

  get discordClient(): Client {
    return this.client;
  }

  get lifecycleState() {
    return this.controller?.getState() ?? null;
  }
}
