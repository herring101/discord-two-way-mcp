import { Client, GatewayIntentBits, type Message } from "discord.js";
import {
  disconnectDatabase,
  initDatabase,
  saveMessage,
} from "./utils/database.js";
import { importAllGuildsAsync } from "./utils/import.js";
import { getTmuxSession, sendToTmux } from "./utils/tmux.js";

export class DiscordClient {
  private client: Client;
  private _isReady = false;
  private tmuxSession: string | null = null;

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
      console.error(
        "⚠️ Warning: tmux外で実行されています。Discordメッセージ通知を受けるには tclaude コマンドで起動してください。",
      );
    } else {
      console.error(`tmux session detected: ${this.tmuxSession}`);
    }

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.client.once("clientReady", async () => {
      console.error(`Discord bot logged in as ${this.client.user?.tag}`);

      // Bot IDでデータベースを初期化
      if (this.client.user) {
        try {
          const { isNewDatabase } = await initDatabase(this.client.user.id);
          console.error(`Database initialized for bot ${this.client.user.id}`);

          // 新規DBの場合は全ギルドのメッセージを非同期でインポート
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

    // メッセージ受信時にDBに保存
    this.client.on("messageCreate", (message: Message) => {
      this.handleMessage(message);
    });
  }

  private handleMessage(message: Message): void {
    // Bot自身のメッセージは無視
    if (message.author.bot) return;

    // DBに保存（非同期）
    saveMessage(message).catch((error) => {
      console.error("Failed to save message to DB:", error);
    });

    // ログ出力
    console.error(
      `[MSG] ${message.author.tag}: ${message.content.slice(0, 50)}${message.content.length > 50 ? "..." : ""}`,
    );

    // tmux通知
    this.notifyTmux(message);
  }

  private notifyTmux(message: Message): void {
    // tmuxセッションがなければスキップ
    if (!this.tmuxSession) return;

    const notification = `[Discord] ${message.author.tag}: ${message.content}`;
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
