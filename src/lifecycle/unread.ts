/**
 * 未読管理ロジック
 * チャンネルごとの未読メッセージ数を追跡する
 */

import type { PrismaClient } from "@prisma/client";
import type { ChannelId, MessageId } from "./types.js";

/**
 * 未読サマリー
 */
export interface UnreadSummary {
  channelId: string;
  guildId: string;
  unreadCount: number;
  lastReadMessageId: string | null;
}

/**
 * 未読数をインクリメント
 * メッセージ受信時に呼び出す
 */
export async function incrementUnread(
  prisma: PrismaClient,
  channelId: ChannelId,
  guildId: string,
): Promise<void> {
  await prisma.channelReadState.upsert({
    where: { channelId },
    update: {
      unreadCount: { increment: 1 },
    },
    create: {
      channelId,
      guildId,
      unreadCount: 1,
    },
  });
}

/**
 * チャンネルを既読にする
 * get_channel_messages, focusChannel, mention/reply 時に呼び出す
 */
export async function markAsRead(
  prisma: PrismaClient,
  channelId: ChannelId,
  lastReadMessageId: MessageId,
): Promise<void> {
  await prisma.channelReadState.updateMany({
    where: { channelId },
    data: {
      unreadCount: 0,
      lastReadMessageId,
    },
  });
}

/**
 * 全チャンネルの未読サマリーを取得
 */
export async function getUnreadSummary(
  prisma: PrismaClient,
): Promise<UnreadSummary[]> {
  const states = await prisma.channelReadState.findMany({
    where: { unreadCount: { gt: 0 } },
    orderBy: { unreadCount: "desc" },
  });

  return states.map((s) => ({
    channelId: s.channelId,
    guildId: s.guildId,
    unreadCount: s.unreadCount,
    lastReadMessageId: s.lastReadMessageId,
  }));
}

/**
 * 特定チャンネルの未読数を取得
 */
export async function getUnreadCount(
  prisma: PrismaClient,
  channelId: ChannelId,
): Promise<number> {
  const state = await prisma.channelReadState.findUnique({
    where: { channelId },
  });
  return state?.unreadCount ?? 0;
}

/**
 * 未読サマリーをプレーンテキストでフォーマット
 */
export function formatUnreadSummary(summaries: UnreadSummary[]): string {
  if (summaries.length === 0) {
    return "未読メッセージはありません。";
  }

  const lines = ["--- 未読サマリー ---"];
  for (const s of summaries) {
    lines.push(`ch:${s.channelId} - ${s.unreadCount}件の未読`);
  }
  return lines.join("\n");
}
