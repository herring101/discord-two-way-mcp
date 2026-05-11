/**
 * Discordスラッシュコマンドの定義と処理
 */

import {
  type ChatInputCommandInteraction,
  type Client,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { getPrismaClient } from "../db/client.js";
import { defaultConfig } from "../lifecycle/config.js";
import { getUnreadSummary } from "../lifecycle/unread.js";
import { getLogger } from "../shared/logger.js";
import { getLifecycleController } from "./client.js";

const logger = getLogger("slash-cmd");

// コマンド定義
const commands = [
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Botの現在の状態を表示します"),
  new SlashCommandBuilder()
    .setName("unread")
    .setDescription("未読メッセージのサマリーを表示します"),
  new SlashCommandBuilder()
    .setName("config")
    .setDescription("Botの設定を表示します"),
  new SlashCommandBuilder()
    .setName("reminders")
    .setDescription("登録されているリマインダーの一覧を表示します"),
];

/**
 * スラッシュコマンドを登録
 */
export async function registerSlashCommands(
  client: Client,
  token: string,
): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);

  try {
    logger.info("Registering commands...");

    const clientId = client.user?.id;
    if (!clientId) {
      throw new Error("Client user ID not available");
    }

    await rest.put(Routes.applicationCommands(clientId), {
      body: commands.map((cmd) => cmd.toJSON()),
    });

    logger.info("Commands registered successfully");
  } catch (error) {
    logger.error("Failed to register commands:", error);
  }
}

/**
 * スラッシュコマンドを処理
 */
export async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const { commandName } = interaction;

  switch (commandName) {
    case "status":
      await handleStatusCommand(interaction);
      break;
    case "unread":
      await handleUnreadCommand(interaction);
      break;
    case "config":
      await handleConfigCommand(interaction);
      break;
    case "reminders":
      await handleRemindersCommand(interaction);
      break;
    default:
      // 知らないコマンドは無視（他のbot/daemonが処理する可能性がある）
      return;
  }
}

async function handleStatusCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const controller = getLifecycleController();

  if (!controller) {
    await interaction.reply({
      content: "⚠️ ライフサイクルコントローラーが初期化されていません",
      flags: 64,
    });
    return;
  }

  const state = controller.getState();

  const modeEmoji = {
    OFF: "😴",
    AWAKE_NOT_WATCHING: "👀",
    AWAKE_WATCHING: "🔍",
  };

  const modeDescription = {
    OFF: "睡眠中（睡眠時間帯）",
    AWAKE_NOT_WATCHING: "起床中（見回り待機）",
    AWAKE_WATCHING: "アクティブ監視中",
  };

  const lines = [
    `## Bot Status`,
    ``,
    `**モード**: ${modeEmoji[state.mode]} ${state.mode}`,
    `> ${modeDescription[state.mode]}`,
    ``,
  ];

  if (state.focusChannelId) {
    lines.push(`**Focus Channel**: <#${state.focusChannelId}>`);
  }

  await interaction.reply({
    content: lines.join("\n"),
    flags: 64,
  });
}

async function handleUnreadCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    const prisma = getPrismaClient();
    const summaries = await getUnreadSummary(prisma);

    if (summaries.length === 0) {
      await interaction.reply({
        content: "✅ 未読メッセージはありません",
        flags: 64,
      });
      return;
    }

    const lines = [`## 未読サマリー`, ``];
    for (const s of summaries) {
      lines.push(`- <#${s.channelId}>: **${s.unreadCount}件**`);
    }

    await interaction.reply({
      content: lines.join("\n"),
      flags: 64,
    });
  } catch (error) {
    logger.error("Failed to get unread summary:", error);
    await interaction.reply({
      content: "⚠️ 未読サマリーの取得に失敗しました",
      flags: 64,
    });
  }
}

async function handleConfigCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const config = defaultConfig;

  const promotionHours = config.promotionMeanIntervalMs / (1000 * 60 * 60);
  const activityMinutes = config.activityTickIntervalMs / (1000 * 60);

  const lines = [
    `## Bot設定`,
    ``,
    `**睡眠時間帯**: ${config.sleepStartTime} 〜 ${config.sleepEndTime}`,
    `**確率昇格間隔**: 平均${promotionHours}時間`,
    `**アクティビティ集計**: ${activityMinutes}分ごと`,
  ];

  await interaction.reply({
    content: lines.join("\n"),
    flags: 64,
  });
}

async function handleRemindersCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const controller = getLifecycleController();

  if (!controller) {
    await interaction.reply({
      content: "⚠️ ライフサイクルコントローラーが初期化されていません",
      flags: 64,
    });
    return;
  }

  const reminders = controller.listReminders();

  if (reminders.length === 0) {
    await interaction.reply({
      content: "✅ 登録されているリマインダーはありません",
      flags: 64,
    });
    return;
  }

  const lines = [`## リマインダー一覧`, ``];

  for (let i = 0; i < reminders.length; i++) {
    const job = reminders[i];
    if (!job) continue;
    const content =
      job.payload.type === "reminder" ? job.payload.content : "(不明)";
    const nextRun = job.nextRunAt
      ? job.nextRunAt.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
      : "未定";

    lines.push(`${i + 1}. **${content}**`);
    lines.push(`   次回: ${nextRun}`);

    if (job.schedule.type === "once") {
      lines.push(`   タイプ: once`);
    } else if (job.schedule.type === "cron") {
      lines.push(`   タイプ: cron (\`${job.schedule.cronExpression}\`)`);
    }

    lines.push(``);
  }

  await interaction.reply({
    content: lines.join("\n"),
    flags: 64,
  });
}
