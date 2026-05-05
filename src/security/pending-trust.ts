/**
 * `PendingTrustRequest` テーブルへの CRUD と TTL 失効ロジック。
 *
 * `manage_trust({action: "add", ...})` が pending を作って owner DM ボタン承認待ちにし、
 * interaction-router がボタン押下時に `resolve()` を呼ぶ。
 *
 * TTL: 24h、lazy check（ボタン押下時に作成日時を見て expired 判定）。
 */

import { getPrismaClient } from "../db/client.js";

const TTL_MS = 24 * 60 * 60 * 1000;

export interface PendingTrustRequest {
  id: string;
  userIds: string[];
  reason: string;
  requestedBy: string;
  dmMessageId: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  resolution: "approved" | "denied" | "expired" | null;
}

function deserialize(row: {
  id: string;
  userIds: string;
  reason: string;
  requestedBy: string;
  dmMessageId: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  resolution: string | null;
}): PendingTrustRequest {
  return {
    id: row.id,
    userIds: JSON.parse(row.userIds),
    reason: row.reason,
    requestedBy: row.requestedBy,
    dmMessageId: row.dmMessageId,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    resolution: row.resolution as PendingTrustRequest["resolution"],
  };
}

export async function createPendingTrustRequest(input: {
  userIds: string[];
  reason: string;
  requestedBy: string;
}): Promise<PendingTrustRequest> {
  const row = await getPrismaClient().pendingTrustRequest.create({
    data: {
      userIds: JSON.stringify(input.userIds),
      reason: input.reason,
      requestedBy: input.requestedBy,
    },
  });
  return deserialize(row);
}

export async function attachDmMessageId(
  id: string,
  dmMessageId: string,
): Promise<void> {
  await getPrismaClient().pendingTrustRequest.update({
    where: { id },
    data: { dmMessageId },
  });
}

export async function findPendingTrustRequest(
  id: string,
): Promise<PendingTrustRequest | null> {
  const row = await getPrismaClient().pendingTrustRequest.findUnique({
    where: { id },
  });
  return row ? deserialize(row) : null;
}

/**
 * 作成から TTL_MS 経過していれば true。
 */
export function isExpired(
  req: PendingTrustRequest,
  now: number = Date.now(),
): boolean {
  return now - req.createdAt.getTime() > TTL_MS;
}

/**
 * resolution 未設定 + 期限内 のリクエストのみ approved/denied/expired にできる。
 * 既に resolved 済みなら null を返して呼び出し側に既決を伝える。
 */
export async function resolvePendingTrustRequest(
  id: string,
  resolution: "approved" | "denied" | "expired",
): Promise<PendingTrustRequest | null> {
  const db = getPrismaClient();
  const existing = await db.pendingTrustRequest.findUnique({ where: { id } });
  if (!existing || existing.resolvedAt) return null;
  const updated = await db.pendingTrustRequest.update({
    where: { id },
    data: { resolution, resolvedAt: new Date() },
  });
  return deserialize(updated);
}
