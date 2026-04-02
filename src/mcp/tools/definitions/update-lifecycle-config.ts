/**
 * ライフサイクル設定更新ツール
 */

import type { Client } from "discord.js";
import { getLifecycleController } from "../../../discord/client.js";
import { timeStringToMinutes } from "../../../lifecycle/index.js";
import { defineTool, jsonResult, textResult } from "../registry.js";

defineTool(
  {
    name: "update_lifecycle_config",
    description:
      "ライフサイクル設定を更新します。睡眠時間帯、昇格間隔、アクティビティチェック間隔を変更できます。変更はDBに永続化され、再起動後も維持されます。",
    inputSchema: {
      type: "object",
      properties: {
        sleepStartTime: {
          type: "string",
          description: "睡眠開始時刻（HH:MM形式、例: '02:30'）",
        },
        sleepEndTime: {
          type: "string",
          description: "睡眠終了時刻（HH:MM形式、例: '10:30'）",
        },
        promotionMeanIntervalMs: {
          type: "number",
          description: "確率昇格の平均間隔（ミリ秒、例: 7200000 = 2時間）",
        },
        activityTickIntervalMs: {
          type: "number",
          description: "アクティビティチェック間隔（ミリ秒、例: 300000 = 5分）",
        },
      },
    },
  },
  async (_client: Client, args: Record<string, unknown>) => {
    const controller = getLifecycleController();

    if (!controller) {
      return textResult(
        "エラー: ライフサイクルコントローラーが初期化されていません",
      );
    }

    const partial: Record<string, unknown> = {};

    if (args.sleepStartTime !== undefined) {
      const s = args.sleepStartTime as string;
      if (!/^\d{2}:\d{2}$/.test(s)) {
        return textResult(
          "エラー: sleepStartTime は HH:MM 形式で指定してください",
        );
      }
      partial.sleepStartTime = s;
    }

    if (args.sleepEndTime !== undefined) {
      const s = args.sleepEndTime as string;
      if (!/^\d{2}:\d{2}$/.test(s)) {
        return textResult(
          "エラー: sleepEndTime は HH:MM 形式で指定してください",
        );
      }
      partial.sleepEndTime = s;
    }

    if (args.promotionMeanIntervalMs !== undefined) {
      const v = args.promotionMeanIntervalMs as number;
      if (v <= 0) {
        return textResult(
          "エラー: promotionMeanIntervalMs は正の値を指定してください",
        );
      }
      partial.promotionMeanIntervalMs = v;
    }

    if (args.activityTickIntervalMs !== undefined) {
      const v = args.activityTickIntervalMs as number;
      if (v <= 0) {
        return textResult(
          "エラー: activityTickIntervalMs は正の値を指定してください",
        );
      }
      partial.activityTickIntervalMs = v;
    }

    if (Object.keys(partial).length === 0) {
      return textResult("エラー: 変更するパラメータを1つ以上指定してください");
    }

    // 睡眠時間のバリデーション（変更後の値で計算）
    const currentConfig = controller.getConfig();
    const newStart =
      (partial.sleepStartTime as string) ?? currentConfig.sleepStartTime;
    const newEnd =
      (partial.sleepEndTime as string) ?? currentConfig.sleepEndTime;

    const startMin = timeStringToMinutes(newStart);
    const endMin = timeStringToMinutes(newEnd);
    let durationMin: number;
    if (endMin > startMin) {
      durationMin = endMin - startMin;
    } else {
      durationMin = 24 * 60 - startMin + endMin;
    }

    if (durationMin < 30) {
      return textResult(
        "エラー: 睡眠時間は最低30分必要です（現在の設定: " +
          `${newStart}〜${newEnd} = ${durationMin}分）`,
      );
    }

    const updated = await controller.updateConfig(partial);

    return jsonResult({
      success: true,
      message: "ライフサイクル設定を更新しました",
      config: {
        sleepStartTime: updated.sleepStartTime,
        sleepEndTime: updated.sleepEndTime,
        promotionMeanIntervalMs: updated.promotionMeanIntervalMs,
        activityTickIntervalMs: updated.activityTickIntervalMs,
      },
    });
  },
  { requiresDiscord: false },
);
