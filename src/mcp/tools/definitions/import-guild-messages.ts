import type { Client } from "discord.js";
import {
  getImportProgress,
  importAllGuildsAsync,
  importGuildMessages,
} from "../../../discord/import.js";
import { defineTool, jsonResult } from "../registry.js";

// ツールを登録
defineTool(
  {
    name: "import_guild_messages",
    description:
      "ギルドの全メッセージをデータベースにインポートします。guildIdを省略すると全ギルドをインポートします。",
    inputSchema: {
      type: "object",
      properties: {
        guildId: {
          type: "string",
          description: "DiscordギルドID（省略時は全ギルド）",
        },
      },
    },
  },
  async (client: Client, args: Record<string, unknown>) => {
    const guildId = args.guildId as string | undefined;
    const progress = getImportProgress();

    // 既にインポート中の場合は進行状況を返す
    if (progress.isRunning) {
      return jsonResult({
        status: "running",
        message: "インポートが進行中です",
        progress: {
          guilds: progress.guildCount,
          channels: progress.channelCount,
          messages: progress.messageCount,
          currentGuild: progress.currentGuild,
          currentChannel: progress.currentChannel,
        },
      });
    }

    if (guildId) {
      // 特定のギルドをインポート
      try {
        const result = await importGuildMessages(client, guildId);
        return jsonResult({
          status: "completed",
          guildId,
          channelCount: result.channelCount,
          messageCount: result.messageCount,
        });
      } catch (error) {
        return jsonResult({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 全ギルドを非同期でインポート
    importAllGuildsAsync(client);

    return jsonResult({
      status: "started",
      message:
        "全ギルドのインポートをバックグラウンドで開始しました。進行状況は再度このツールを呼び出すと確認できます。",
    });
  },
);
