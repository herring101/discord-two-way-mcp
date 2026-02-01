/**
 * リマインダー一覧ツール
 */

import type { Client } from "discord.js";
import { getLifecycleController } from "../../../discord/client.js";
import { defineTool, jsonResult, textResult } from "../registry.js";

defineTool(
  {
    name: "list_reminders",
    description: "登録されているリマインダーの一覧を取得します。",
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

    const reminders = controller.listReminders();

    if (reminders.length === 0) {
      return jsonResult({
        message: "リマインダーはありません",
        reminders: [],
      });
    }

    const formattedReminders = reminders.map((job) => {
      const base: Record<string, unknown> = {
        id: job.id,
        content: job.payload.type === "reminder" ? job.payload.content : "",
        enabled: job.enabled,
        createdAt: job.createdAt.toISOString(),
        nextRunAt: job.nextRunAt?.toISOString() ?? null,
        lastRunAt: job.lastRunAt?.toISOString() ?? null,
      };

      if (job.schedule.type === "once") {
        base.type = "once";
        base.executeAt = job.schedule.executeAt.toISOString();
      } else if (job.schedule.type === "cron") {
        base.type = "cron";
        base.cronExpression = job.schedule.cronExpression;
      }

      return base;
    });

    return jsonResult({
      message: `${reminders.length}件のリマインダーがあります`,
      reminders: formattedReminders,
    });
  },
);
