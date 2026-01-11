/**
 * 未読管理ロジック
 * チャンネルごとの未読メッセージをUnreadMessageテーブルで個別管理する
 */

import type { PrismaClient } from "../db/generated/prisma/client.js";
import type {
  ChannelId,
  MessageId,
  UnreadSummaryWithDetails,
} from "./types.js";

/**
 * 未読サマリー
 */
export interface UnreadSummary {
  channelId: string;
  guildId: string;
  unreadCount: number;
}

/**
 * 未読メッセージを追加
 * メッセージ受信時に呼び出す
 */
export async function addUnreadMessage(
  prisma: PrismaClient,
  channelId: ChannelId,
  messageId: MessageId,
  guildId: string,
): Promise<void> {
  // UnreadMessageテーブルに追加
  // 既に存在する場合は何もしない
  await prisma.unreadMessage.upsert({
    where: {
      channelId_messageId: {
        channelId,
        messageId,
      },
    },
    update: {},
    create: {
      channelId,
      messageId,
      guildId,
    },
  });
}

/**
 * チャンネルを既読にする
 * 指定されたメッセージID以前の未読メッセージをすべて削除する
 */
export async function markAsRead(
  prisma: PrismaClient,
  channelId: ChannelId,
  lastReadMessageId: MessageId,
): Promise<void> {
  await prisma.$transaction([
    // 未読メッセージを削除
    prisma.unreadMessage.deleteMany({
      where: { channelId },
    }),
    // 既読位置を更新
    prisma.channelReadState.upsert({
      where: { channelId },
      update: {
        lastReadMessageId,
        unreadCount: 0, // 互換性のため0にしておく
      },
      create: {
        channelId,
        guildId:
          (await prisma.channel.findUnique({ where: { id: channelId } }))
            ?.guildId ?? "unknown",
        lastReadMessageId,
        unreadCount: 0,
      },
    }),
  ]);
}

/**
 * 全チャンネルの未読サマリーを取得
 */
export async function getUnreadSummary(
  prisma: PrismaClient,
): Promise<UnreadSummary[]> {
  // チャネルごとに未読数をカウント
  const groups = await prisma.unreadMessage.groupBy({
    by: ["channelId", "guildId"],
    _count: {
      messageId: true,
    },
    orderBy: {
      _count: {
        messageId: "desc",
      },
    },
  });

  // Prismaの型推論が効きにくい場合があるため any キャストで回避
  // biome-ignore lint/suspicious/noExplicitAny: Prisma groupBy output type inference
  return groups.map((g: any) => ({
    channelId: g.channelId,
    guildId: g.guildId,
    unreadCount: g._count.messageId,
  }));
}

/**
 * 直近N分間の未読メッセージを取得
 */
export async function getRecentUnreadMessages(
  prisma: PrismaClient,
  minutes: number,
): Promise<UnreadSummaryWithDetails[]> {
  const cutoff = new Date(Date.now() - minutes * 60 * 1000);

  // 直近N分に作成された未読レコードを取得
  const unreads = await prisma.unreadMessage.findMany({
    where: {
      createdAt: {
        gte: cutoff,
      },
    },
    select: {
      channelId: true,
      guildId: true,
      messageId: true,
      createdAt: true,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (unreads.length === 0) {
    return [];
  }

  // チャンネルごとに整理
  const channelMap = new Map<string, UnreadSummaryWithDetails>();

  for (const u of unreads) {
    if (!channelMap.has(u.channelId)) {
      channelMap.set(u.channelId, {
        channelId: u.channelId,
        guildId: u.guildId,
        unreadCount: 0,
        messages: [],
      });
    }

    const entry = channelMap.get(u.channelId);
    if (!entry) continue;

    entry.unreadCount++;

    const message = await prisma.message.findUnique({
      where: { id: u.messageId },
    });

    if (message) {
      entry.messages.push({
        messageId: message.id,
        authorUsername: message.authorUsername,
        content: message.content,
        createdAt: message.createdAt,
      });
    }
  }

  // カウントの多い順にソート
  return Array.from(channelMap.values()).sort(
    (a, b) => b.unreadCount - a.unreadCount,
  );
}

/**
 * 未読サマリーをプレーンテキストでフォーマット
 */
export function formatUnreadSummary(summaries: UnreadSummary[]): string | null {
  if (summaries.length === 0) {
    return null;
  }

  const lines = ["--- 未読サマリー ---"];
  for (const s of summaries) {
    lines.push(`ch:${s.channelId} - ${s.unreadCount}件の未読`);
  }
  return lines.join("\n");
}
