import { Client, DMChannel, GatewayIntentBits, type Message } from "discord.js";
import {
  disconnectDatabase,
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

export class DiscordClient {
  private client: Client;
  private _isReady = false;
  private tmuxSession: string | null = null;
  private lastNotifiedDate: Date | null = null;

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
  }

  private handleMessage(message: Message): void {
    // 自分自身（Bot）のメッセージは無視
    if (message.author.id === this.client.user?.id) return;

    saveMessage(message).catch((error) => {
      console.error("Failed to save message to DB:", error);
    });

    console.error(
      `[MSG] ${message.author.tag}: ${message.content.slice(0, 50)}${message.content.length > 50 ? "..." : ""}`,
    );

    this.notifyTmux(message);
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
    await disconnectDatabase();
    await this.client.destroy();
  }

  get isReady(): boolean {
    return this._isReady;
  }

  get discordClient(): Client {
    return this.client;
  }
}
