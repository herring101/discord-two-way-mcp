import {
  ChannelType,
  type Client,
  type Collection,
  type ForumChannel,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import { getPrismaClient, saveGuild, saveMessage } from "../db/client.js";
import { getLogger } from "../shared/logger.js";

const logger = getLogger("import");

const BATCH_SIZE = 100;
const DELAY_MS = 500;

interface ImportProgress {
  guildCount: number;
  channelCount: number;
  messageCount: number;
  isRunning: boolean;
  currentGuild?: string;
  currentChannel?: string;
}

// グローバルな進行状況
let importProgress: ImportProgress = {
  guildCount: 0,
  channelCount: 0,
  messageCount: 0,
  isRunning: false,
};

/**
 * 現在のインポート進行状況を取得
 */
export function getImportProgress(): ImportProgress {
  return { ...importProgress };
}

/**
 * テキストベースのチャンネルかどうかを判定
 */
function isTextBasedChannel(channel: unknown): boolean {
  if (!channel || typeof channel !== "object") return false;
  const ch = channel as { type?: ChannelType };
  return (
    ch.type === ChannelType.GuildText ||
    ch.type === ChannelType.GuildAnnouncement ||
    ch.type === ChannelType.PublicThread ||
    ch.type === ChannelType.PrivateThread ||
    ch.type === ChannelType.AnnouncementThread
  );
}

/**
 * 遅延
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * チャンネルのメッセージをインポート
 */
async function importChannelMessages(
  channel: TextChannel | ThreadChannel,
  guildId: string,
): Promise<number> {
  const prisma = getPrismaClient();
  const channelName = channel.name || "unknown";

  // チャンネル情報を保存
  await prisma.channel.upsert({
    where: { id: channel.id },
    update: {
      name: channelName,
      type: channel.type,
      position: "position" in channel ? (channel.position ?? 0) : 0,
      parentId: "parentId" in channel ? (channel.parentId ?? null) : null,
    },
    create: {
      id: channel.id,
      guildId,
      name: channelName,
      type: channel.type,
      position: "position" in channel ? (channel.position ?? 0) : 0,
      parentId: "parentId" in channel ? (channel.parentId ?? null) : null,
    },
  });

  let lastMessageId: string | undefined;
  let hasMore = true;
  let fetchedCount = 0;

  while (hasMore) {
    try {
      const fetchOptions: { limit: number; before?: string } = {
        limit: BATCH_SIZE,
      };
      if (lastMessageId) {
        fetchOptions.before = lastMessageId;
      }

      const messages = (await channel.messages.fetch(
        fetchOptions,
      )) as Collection<string, Message>;

      if (messages.size === 0) {
        hasMore = false;
        break;
      }

      for (const message of [...messages.values()].reverse()) {
        try {
          await saveMessage(message);
          fetchedCount++;
          importProgress.messageCount++;
        } catch {
          // 個別のメッセージ保存エラーは無視して続行
        }
      }

      lastMessageId = messages.last()?.id;
      await delay(DELAY_MS);
    } catch (error) {
      logger.error(
        `Failed to fetch messages for ${channelName}:`,
        error instanceof Error ? error.message : error,
      );
      hasMore = false;
    }
  }

  return fetchedCount;
}

/**
 * フォーラムチャンネルのスレッドをインポート
 */
async function importForumThreads(
  forumChannel: ForumChannel,
  guildId: string,
): Promise<void> {
  try {
    const activeThreads = await forumChannel.threads.fetchActive();
    const archivedThreads = await forumChannel.threads.fetchArchived();

    for (const thread of activeThreads.threads.values()) {
      importProgress.currentChannel = thread.name;
      await importChannelMessages(thread, guildId);
      importProgress.channelCount++;
    }

    for (const thread of archivedThreads.threads.values()) {
      importProgress.currentChannel = thread.name;
      await importChannelMessages(thread, guildId);
      importProgress.channelCount++;
    }
  } catch (error) {
    logger.error(
      `Failed to import forum threads:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * 1つのギルドのメッセージをインポート
 */
export async function importGuildMessages(
  client: Client,
  guildId: string,
): Promise<{ messageCount: number; channelCount: number }> {
  const guild = await client.guilds.fetch(guildId);
  await saveGuild(guild);

  importProgress.currentGuild = guild.name;
  logger.info(`Starting import for guild: ${guild.name}`);

  const channels = await guild.channels.fetch();
  let messageCount = 0;
  let channelCount = 0;

  for (const channel of channels.values()) {
    if (!channel) continue;

    if (channel.type === ChannelType.GuildForum) {
      await importForumThreads(channel as ForumChannel, guildId);
      continue;
    }

    if (isTextBasedChannel(channel)) {
      importProgress.currentChannel = channel.name;
      const count = await importChannelMessages(
        channel as TextChannel | ThreadChannel,
        guildId,
      );
      messageCount += count;
      channelCount++;
      importProgress.channelCount++;
      logger.info(`Channel #${channel.name}: ${count} messages`);
    }
  }

  logger.info(
    `Guild ${guild.name} complete: ${channelCount} channels, ${messageCount} messages`,
  );
  importProgress.guildCount++;

  return { messageCount, channelCount };
}

/**
 * Botが参加している全ギルドをインポート（非同期・ノンブロッキング）
 */
export function importAllGuildsAsync(client: Client): void {
  if (importProgress.isRunning) {
    logger.warn("Import already in progress, skipping...");
    return;
  }

  importProgress = {
    guildCount: 0,
    channelCount: 0,
    messageCount: 0,
    isRunning: true,
  };

  // 非同期で実行（awaitしない）
  (async () => {
    try {
      const guilds = client.guilds.cache;
      logger.info(`Starting async import for ${guilds.size} guilds...`);

      for (const guild of guilds.values()) {
        try {
          await importGuildMessages(client, guild.id);
        } catch (error) {
          logger.error(
            `Failed to import guild ${guild.name}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }

      logger.info(
        `All guilds import complete: ${importProgress.guildCount} guilds, ${importProgress.channelCount} channels, ${importProgress.messageCount} messages`,
      );
    } catch (error) {
      logger.error("Fatal error:", error);
    } finally {
      importProgress.isRunning = false;
    }
  })();
}
