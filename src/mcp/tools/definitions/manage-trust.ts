/**
 * manage_trust: trusted ユーザーの list / add (DM 承認) / remove。
 *
 * - list: env / owner / bot / DB を統合した最新リストを返す
 * - add: PendingTrustRequest を作って owner DM にボタン付き Embed を送り、tool は即時 return
 *        ボタン押下は interaction-router の `trust_approve` / `trust_deny` ハンドラが処理
 * - remove: TrustedUser テーブルから即削除、notify_owner で透明性報告
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type Client,
} from "discord.js";
import { getLifecycleController } from "../../../discord/client.js";
import { resolveOwnerDM } from "../../../discord/dm-resolver.js";
import { registerButtonHandler } from "../../../discord/interaction-router.js";
import { getOwnerConfig } from "../../../security/config.js";
import {
  attachDmMessageId,
  createPendingTrustRequest,
  findPendingTrustRequest,
  isExpired,
  resolvePendingTrustRequest,
} from "../../../security/pending-trust.js";
import {
  addTrustedUsers,
  listTrustedUsers,
  removeTrustedUsers,
} from "../../../security/trust.js";
import { getLogger } from "../../../shared/logger.js";
import { ToolInputError } from "../../errors.js";
import { defineTool, jsonResult, type ToolResult } from "../registry.js";
import { validateActionEnum } from "../validators.js";
import { sendOwnerNotification } from "./notify-owner.js";

const logger = getLogger("manage-trust");

defineTool(
  {
    name: "manage_trust",
    description:
      "trusted ユーザーの管理。list で一覧取得、add で追加リクエスト (本人 DM ボタン承認)、remove で削除 (即時、本人へ事後通知)。",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "list / add / remove",
          enum: ["list", "add", "remove"],
        },
        userIds: {
          type: "array",
          description:
            "Discord User ID の配列。add / remove で必須。複数指定で 1 リクエスト 1 タップ承認。",
        },
        reason: {
          type: "string",
          description:
            "add リクエストの理由。owner の DM に Embed として表示される。",
        },
      },
      required: ["action"],
    },
  },
  async (
    client: Client,
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    const action = validateActionEnum(
      args.action,
      ["list", "add", "remove"] as const,
      "action",
    );

    if (action === "list") {
      const entries = await listTrustedUsers();
      return jsonResult({
        ok: true,
        count: entries.length,
        entries: entries.map((e) => ({
          userId: e.userId,
          source: e.source,
          addedAt: e.addedAt?.toISOString() ?? null,
          note: e.note ?? null,
        })),
      });
    }

    const userIds = parseUserIds(args.userIds);
    if (userIds.length === 0) {
      throw new ToolInputError("userIds は 1 件以上必要です。");
    }

    if (action === "remove") {
      const result = await removeTrustedUsers(userIds);
      // 透明性のため notify_owner に通知（失敗しても remove 結果は変えない）
      sendOwnerNotification(client, {
        message:
          `manage_trust remove\n` +
          `removed: ${result.removed.join(", ") || "(なし)"}\n` +
          `notFound: ${result.notFound.join(", ") || "(なし)"}\n` +
          `※ env / owner / bot 由来の trusted は DB に行が無いので削除対象外です。`,
        severity: "info",
        category: "trust_remove",
      }).catch((err) => {
        logger.warn(`notify_owner (trust_remove) failed: ${String(err)}`);
      });
      return jsonResult({
        ok: true,
        removed: result.removed,
        notFound: result.notFound,
      });
    }

    // action === "add"
    const reason = (args.reason as string | undefined)?.trim();
    if (!reason) {
      throw new ToolInputError(
        "add では reason が必須です（owner DM に表示します）。",
      );
    }

    const requestedBy =
      getLifecycleController() !== null ? "clamane" : "unknown";
    const pending = await createPendingTrustRequest({
      userIds,
      reason,
      requestedBy,
    });

    let dm: Awaited<ReturnType<typeof resolveOwnerDM>>;
    try {
      dm = await resolveOwnerDM(client);
    } catch (error) {
      return jsonResult({
        ok: false,
        reason: "dm_unavailable",
        message: error instanceof Error ? error.message : String(error),
        pendingId: pending.id,
      });
    }

    const userListMd = userIds.map((id) => `• <@${id}> (\`${id}\`)`).join("\n");
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`trust_approve:${pending.id}`)
        .setLabel("承認")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`trust_deny:${pending.id}`)
        .setLabel("拒否")
        .setStyle(ButtonStyle.Danger),
    );

    let dmMessage: Awaited<ReturnType<typeof dm.send>>;
    try {
      dmMessage = await dm.send({
        embeds: [
          {
            title: "🔐 信頼ユーザー追加リクエスト",
            description: reason,
            fields: [
              { name: "対象ユーザー", value: userListMd, inline: false },
              { name: "依頼者", value: requestedBy, inline: true },
              { name: "リクエスト ID", value: pending.id, inline: true },
            ],
            color: 0x3498db,
            footer: { text: "24h 以内に承認/拒否してください" },
            timestamp: new Date().toISOString(),
          },
        ],
        components: [row.toJSON()],
      });
    } catch (error) {
      return jsonResult({
        ok: false,
        reason: "dm_send_failed",
        message: error instanceof Error ? error.message : String(error),
        pendingId: pending.id,
      });
    }

    await attachDmMessageId(pending.id, dmMessage.id);

    return jsonResult({
      ok: true,
      status: "pending",
      pendingId: pending.id,
      dmMessageId: dmMessage.id,
      userIds,
    });
  },
);

function parseUserIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ============================================================
// Button interaction handlers (DM 上の承認/拒否)
// ============================================================

async function handleTrustButton(
  interaction: ButtonInteraction,
  pendingId: string,
  action: "approve" | "deny",
): Promise<void> {
  const owner = await getOwnerConfig();
  if (interaction.user.id !== owner.ownerUserId) {
    await interaction.reply({
      content: "⚠️ このボタンは owner 本人のみ操作できます。",
      flags: 64,
    });
    return;
  }

  const pending = await findPendingTrustRequest(pendingId);
  if (!pending) {
    await interaction.update({
      content: "❌ リクエストが見つかりません。",
      components: [],
    });
    return;
  }
  if (pending.resolvedAt) {
    await interaction.reply({
      content: `既に ${pending.resolution} 済みです (${pending.resolvedAt.toISOString()})。`,
      flags: 64,
    });
    return;
  }
  if (isExpired(pending)) {
    await resolvePendingTrustRequest(pendingId, "expired");
    await interaction.update({
      content: "⏰ 24h 経過したため自動失効しました。",
      components: [],
    });
    return;
  }

  const resolved = await resolvePendingTrustRequest(
    pendingId,
    action === "approve" ? "approved" : "denied",
  );
  if (!resolved) {
    await interaction.reply({
      content: "⚠️ 競合: 別経路で既に処理されたようです。",
      flags: 64,
    });
    return;
  }

  if (action === "approve") {
    await addTrustedUsers(pending.userIds, owner.ownerUserId, pending.reason);
    await interaction.update({
      content: `✅ 承認しました。trusted に追加: ${pending.userIds.map((id) => `<@${id}>`).join(", ")}`,
      components: [],
    });
    logger.info(
      `Trust request ${pendingId} approved by owner: ${pending.userIds.join(",")}`,
    );
  } else {
    await interaction.update({
      content: `❌ 拒否しました。対象: ${pending.userIds.map((id) => `<@${id}>`).join(", ")}`,
      components: [],
    });
    logger.info(
      `Trust request ${pendingId} denied by owner: ${pending.userIds.join(",")}`,
    );
  }
}

registerButtonHandler("trust_approve", (i, payload) =>
  handleTrustButton(i, payload, "approve"),
);
registerButtonHandler("trust_deny", (i, payload) =>
  handleTrustButton(i, payload, "deny"),
);
