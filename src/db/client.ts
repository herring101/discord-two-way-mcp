import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import type { Channel, Guild, Message } from "discord.js";
import { getLogger } from "../shared/logger.js";
import { PrismaClient } from "./generated/prisma/client.js";

const logger = getLogger("db");

let prisma: PrismaClient | null = null;
let currentBotId: string | null = null;

const DATA_DIR = join(import.meta.dirname, "../../data/db");
const SCHEMA_PATH = join(import.meta.dirname, "./prisma/schema.prisma");

/**
 * DBファイルのパスを取得
 */
function getDbFilePath(botId: string): string {
  return join(DATA_DIR, `bot_${botId}.sqlite`);
}

export interface InitDatabaseResult {
  prisma: PrismaClient;
  isNewDatabase: boolean;
}

/**
 * Bot用のデータベースを初期化
 * - DBディレクトリが存在しなければ作成
 * - スキーマをプッシュ
 * - PrismaClientをドライバーアダプター経由で初期化
 * @returns PrismaClientと新規作成かどうかのフラグ
 */
export async function initDatabase(botId: string): Promise<InitDatabaseResult> {
  // 既に同じBot IDで初期化済みの場合はそのまま返す
  if (prisma && currentBotId === botId) {
    return { prisma, isNewDatabase: false };
  }

  // 既存の接続があれば切断
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }

  // データディレクトリを作成
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  // 新規DBかどうかを判定
  const dbFilePath = getDbFilePath(botId);
  const isNewDatabase = !existsSync(dbFilePath);

  logger.info(`Initializing database for bot ${botId}...`);

  const databaseUrl = `file:${dbFilePath}`;

  // スキーマをプッシュ（テーブル作成・更新）- ローカルの Prisma CLI を使用
  // 常に実行して最新のスキーマを適用する
  const prismaPath = join(
    import.meta.dirname,
    "../../node_modules/.bin/prisma",
  );
  try {
    execSync(
      `"${prismaPath}" db push --schema="${SCHEMA_PATH}" --url="${databaseUrl}"`,
      {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    logger.info("Database schema pushed successfully");
  } catch (error) {
    logger.error("Failed to push database schema:", error);
    throw error;
  }

  // Prisma 7: libsql アダプターファクトリーを使用（Bun 対応）
  const adapter = new PrismaLibSql({
    url: databaseUrl,
  });

  prisma = new PrismaClient({ adapter });

  logger.info(`Database initialized: ${dbFilePath}`);

  currentBotId = botId;
  return { prisma, isNewDatabase };
}

/**
 * 現在のPrismaClientを取得
 */
export function getPrismaClient(): PrismaClient {
  if (!prisma) {
    throw new Error(
      "Database not initialized. Call initDatabase(botId) first.",
    );
  }
  return prisma;
}

/**
 * データベース接続を切断
 */
export async function disconnectDatabase(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
    currentBotId = null;
  }
}

/**
 * ギルド情報をDBに保存
 */
export async function saveGuild(guild: Guild): Promise<void> {
  const db = getPrismaClient();
  await db.guild.upsert({
    where: { id: guild.id },
    update: { name: guild.name, icon: guild.iconURL() },
    create: { id: guild.id, name: guild.name, icon: guild.iconURL() },
  });
}

/**
 * チャンネル情報をDBに保存
 */
export async function saveChannel(
  channel: Channel & {
    name?: string;
    position?: number;
    parentId?: string | null;
  },
  guildId: string,
): Promise<void> {
  const db = getPrismaClient();
  const channelName = "name" in channel ? (channel.name as string) : "unknown";
  const position = "position" in channel ? (channel.position as number) : 0;
  const parentId =
    "parentId" in channel ? (channel.parentId as string | null) : null;

  await db.channel.upsert({
    where: { id: channel.id },
    update: { name: channelName, type: channel.type, position, parentId },
    create: {
      id: channel.id,
      guildId,
      name: channelName,
      type: channel.type,
      position,
      parentId,
    },
  });
}

/**
 * メッセージをDBに保存
 */
export async function saveMessage(message: Message): Promise<void> {
  const db = getPrismaClient();
  const guildId = message.guild?.id;
  if (!guildId) return; // DMは現時点では保存しない

  // ギルドとチャンネルを先に保存
  if (message.guild) {
    await saveGuild(message.guild);
  }
  // @ts-expect-error - channel type varies
  await saveChannel(message.channel, guildId);

  await db.message.upsert({
    where: { id: message.id },
    update: {
      content: message.content,
      authorDisplayName: message.member?.displayName ?? message.author.username,
      embeds: JSON.stringify(message.embeds.map((e) => e.toJSON())),
      hasLink: /https?:\/\/[^\s]+/.test(message.content),
      hasAttachment: message.attachments.size > 0,
    },
    create: {
      id: message.id,
      channelId: message.channelId,
      guildId,
      authorId: message.author.id,
      authorUsername: message.author.username,
      authorDisplayName: message.member?.displayName ?? message.author.username,
      authorBot: message.author.bot,
      content: message.content,
      timestamp: message.createdAt,
      embeds: JSON.stringify(message.embeds.map((e) => e.toJSON())),
      hasLink: /https?:\/\/[^\s]+/.test(message.content),
      hasAttachment: message.attachments.size > 0,
    },
  });

  // 添付ファイルを保存
  for (const att of message.attachments.values()) {
    await db.attachment.upsert({
      where: { id: `${message.id}_${att.name || "unknown"}` },
      update: {
        url: att.url,
        size: att.size,
        contentType: att.contentType,
      },
      create: {
        id: `${message.id}_${att.name || "unknown"}`,
        messageId: message.id,
        filename: att.name || "unknown",
        url: att.url,
        size: att.size,
        contentType: att.contentType,
      },
    });
  }

  // リアクションを保存
  for (const reaction of message.reactions.cache.values()) {
    if (reaction.count > 0) {
      const emoji = reaction.emoji.name ?? reaction.emoji.toString();
      await db.reaction.upsert({
        where: { messageId_emoji: { messageId: message.id, emoji } },
        update: { count: reaction.count },
        create: {
          messageId: message.id,
          emoji,
          count: reaction.count,
        },
      });
    }
  }
}

/**
 * 複数のメッセージをDBに保存
 */
export async function saveMessages(messages: Message[]): Promise<void> {
  for (const message of messages) {
    try {
      await saveMessage(message);
    } catch (error) {
      logger.error(`Failed to save message ${message.id}:`, error);
    }
  }
}
