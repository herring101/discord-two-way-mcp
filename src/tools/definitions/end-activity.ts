/**
 * アクティビティ終了ツール
 * AIがWATCHINGをやめて NOT_WATCHING に戻るためのツール
 */

import type { Client } from "discord.js";
import { getLifecycleController } from "../../discord-client.js";
import { defineTool, textResult } from "../registry.js";

defineTool(
  {
    name: "end_activity",
    description:
      "Discordの監視を終了し、待機状態に戻ります。作業を一段落したときに呼び出してください。待機状態でも、メンションやリプライがあれば通知されます。",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  async (_client: Client, _args: Record<string, unknown>) => {
    const controller = getLifecycleController();

    if (!controller) {
      return textResult(
        "エラー: ライフサイクルコントローラーが初期化されていません",
      );
    }

    const stateBefore = controller.getState();

    if (stateBefore.mode !== "AWAKE_WATCHING") {
      return textResult(
        `現在のモードは ${stateBefore.mode} です。AWAKE_WATCHING 状態でのみ終了できます。`,
      );
    }

    await controller.setNotWatching();

    const stateAfter = controller.getState();

    return textResult(
      `アクティビティを終了しました。\n` +
        `モード: ${stateBefore.mode} → ${stateAfter.mode}\n` +
        `メンションやリプライがあれば再度通知されます。`,
    );
  },
);
