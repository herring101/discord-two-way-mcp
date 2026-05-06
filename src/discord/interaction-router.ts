/**
 * Button Interaction の prefix-based dispatcher。
 *
 * `customId` の prefix (':' まで) でハンドラーを登録/解決する。各機能 (manage_trust 等) が
 * 自分のハンドラーを `registerButtonHandler` で登録する想定。
 *
 * 例:
 *   registerButtonHandler("trust_approve", async (i, payload) => { ... })
 *   customId = "trust_approve:abc123" → handler が payload="abc123" で呼ばれる
 */

import type { ButtonInteraction } from "discord.js";
import { getLogger } from "../shared/logger.js";

const logger = getLogger("interaction-router");

export type ButtonHandler = (
  interaction: ButtonInteraction,
  payload: string,
) => Promise<void>;

const handlers = new Map<string, ButtonHandler>();

export function registerButtonHandler(
  prefix: string,
  handler: ButtonHandler,
): void {
  if (handlers.has(prefix)) {
    logger.warn(`Button handler for "${prefix}" overwritten`);
  }
  handlers.set(prefix, handler);
}

/** テスト用に全ハンドラーをクリア。 */
export function clearButtonHandlers(): void {
  handlers.clear();
}

/**
 * Button interaction を prefix で dispatch する。
 * 該当ハンドラーがなければエフェメラルで通知して終わる。
 */
export async function handleButtonInteraction(
  interaction: ButtonInteraction,
): Promise<void> {
  const customId = interaction.customId;
  const colonIdx = customId.indexOf(":");
  const prefix = colonIdx === -1 ? customId : customId.slice(0, colonIdx);
  const payload = colonIdx === -1 ? "" : customId.slice(colonIdx + 1);

  const handler = handlers.get(prefix);
  if (!handler) {
    logger.warn(`No handler for button customId prefix "${prefix}"`);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: `⚠️ 未対応のボタン (${prefix}) です。`,
        flags: 64,
      });
    }
    return;
  }

  try {
    await handler(interaction, payload);
  } catch (error) {
    logger.error(`Button handler "${prefix}" failed:`, error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply({
          content: "⚠️ 処理中にエラーが発生しました。",
          flags: 64,
        })
        .catch(() => {});
    }
  }
}
