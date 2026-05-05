/**
 * notify_owner: 横断 AI 共通の通知レーン。本人 (owner) の DM に Embed で通知を送る。
 * 後続の self-edit 報告 / 怪しい入力の報告 / 一般通知すべての統合点。
 */

import type { Client } from "discord.js";
import { getPrismaClient } from "../../../db/client.js";
import {
  DmDeliveryError,
  resolveOwnerDM,
} from "../../../discord/dm-resolver.js";
import {
  buildNotificationEmbeds,
  parseSeverity,
} from "../../../security/notify.js";
import { getLogger } from "../../../shared/logger.js";
import { defineTool, jsonResult, type ToolResult } from "../registry.js";

const logger = getLogger("notify-owner");

defineTool(
  {
    name: "notify_owner",
    description:
      "本人 (owner) の Discord DM に通知を送ります。横断 AI 共通の通知レーン。severity で重要度、category で用途を分類。長文は自動で分割送信されます。",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "通知本文（必須）",
        },
        severity: {
          type: "string",
          description:
            "重要度。info=日常通知 / warn=注意喚起 / threat=プロンプトインジェクション疑い等の脅威報告（デフォルト: info）",
          enum: ["info", "warn", "threat"],
          default: "info",
        },
        category: {
          type: "string",
          description:
            '用途分類。例: "self_edit" (CLAUDE.md 編集報告) / "injection_suspect" (怪しい入力) / "general"',
        },
      },
      required: ["message"],
    },
  },
  async (
    client: Client,
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    const message = (args.message as string | undefined)?.trim();
    if (!message) {
      throw new Error("message は必須です（空文字不可）。");
    }
    const severity = parseSeverity(args.severity);
    const category =
      typeof args.category === "string" && args.category.trim().length > 0
        ? args.category.trim()
        : undefined;

    const embeds = buildNotificationEmbeds({ message, severity, category });

    let dm: Awaited<ReturnType<typeof resolveOwnerDM>>;
    try {
      dm = await resolveOwnerDM(client);
    } catch (error) {
      const reason =
        error instanceof DmDeliveryError ? error.message : String(error);
      logger.warn(`Owner DM 解決失敗: ${reason}`);
      return jsonResult({
        ok: false,
        reason: "dm_unavailable",
        message: reason,
      });
    }

    const sentMessageIds: string[] = [];
    try {
      for (const embed of embeds) {
        const sent = await dm.send({
          embeds: [
            {
              title: embed.title,
              description: embed.description,
              color: embed.color,
              footer: embed.footer ? { text: embed.footer } : undefined,
              timestamp: new Date().toISOString(),
            },
          ],
        });
        sentMessageIds.push(sent.id);
      }
    } catch (error) {
      logger.warn(`Owner DM 送信失敗: ${String(error)}`);
      return jsonResult({
        ok: false,
        reason: "dm_send_failed",
        message: error instanceof Error ? error.message : String(error),
        partialMessageIds: sentMessageIds,
      });
    }

    // DB 履歴は fire-and-forget。失敗してもツールの成功扱いを変えない（送信は成功している）。
    const db = getPrismaClient();
    db.notification
      .create({
        data: {
          severity,
          category,
          message,
          dmMessageId: sentMessageIds[0] ?? null,
        },
      })
      .catch((err) => {
        logger.error("Notification 履歴の保存に失敗:", err);
      });

    return jsonResult({
      ok: true,
      severity,
      category: category ?? null,
      partCount: embeds.length,
      messageIds: sentMessageIds,
    });
  },
);
