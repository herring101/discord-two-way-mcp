/**
 * リマインダー削除ツール
 */

import type { Client } from "discord.js";
import { getLifecycleController } from "../../../discord/client.js";
import { defineTool, jsonResult, textResult } from "../registry.js";

defineTool(
  {
    name: "delete_reminder",
    description: "指定したリマインダーを削除します。",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "削除するリマインダーのID",
        },
      },
      required: ["id"],
    },
  },
  async (_client: Client, args: Record<string, unknown>) => {
    const controller = getLifecycleController();

    if (!controller) {
      return textResult(
        "エラー: ライフサイクルコントローラーが初期化されていません",
      );
    }

    const id = args.id as string;

    const deleted = await controller.deleteReminder(id);

    if (deleted) {
      return jsonResult({
        success: true,
        message: "リマインダーを削除しました",
        id,
      });
    }

    return jsonResult({
      success: false,
      message: "リマインダーが見つかりませんでした",
      id,
    });
  },
);
