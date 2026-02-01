/**
 * リマインダー作成ツール
 */

import type { Client } from "discord.js";
import { getLifecycleController } from "../../../discord/client.js";
import { defineTool, jsonResult, textResult } from "../registry.js";

defineTool(
  {
    name: "create_reminder",
    description:
      "リマインダーを作成します。単発（once）または繰り返し（cron）のリマインダーを設定できます。",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "リマインダーの内容",
        },
        type: {
          type: "string",
          description:
            "リマインダーのタイプ: 'once'（単発）または 'cron'（繰り返し）",
          enum: ["once", "cron"],
        },
        executeAt: {
          type: "string",
          description:
            "実行時刻（ISO8601形式、type='once'の場合に必須）。例: 2024-01-15T10:00:00+09:00",
        },
        cronExpression: {
          type: "string",
          description:
            "cron式（type='cron'の場合に必須）。例: '0 9 * * *'（毎日9時）, '0 10 * * 1'（毎週月曜10時）",
        },
      },
      required: ["content", "type"],
    },
  },
  async (_client: Client, args: Record<string, unknown>) => {
    const controller = getLifecycleController();

    if (!controller) {
      return textResult(
        "エラー: ライフサイクルコントローラーが初期化されていません",
      );
    }

    const content = args.content as string;
    const type = args.type as "once" | "cron";

    if (type === "once") {
      const executeAtStr = args.executeAt as string | undefined;
      if (!executeAtStr) {
        return textResult("エラー: type='once' の場合は executeAt が必須です");
      }

      const executeAt = new Date(executeAtStr);
      if (Number.isNaN(executeAt.getTime())) {
        return textResult(
          "エラー: executeAt の形式が不正です。ISO8601形式で指定してください。",
        );
      }

      try {
        const job = await controller.createReminder(content, {
          type: "once",
          executeAt,
        });

        return jsonResult({
          success: true,
          message: "リマインダーを作成しました",
          reminder: {
            id: job.id,
            content,
            type: "once",
            executeAt: executeAt.toISOString(),
            nextRunAt: job.nextRunAt?.toISOString(),
          },
        });
      } catch (error) {
        return textResult(
          `エラー: ${error instanceof Error ? error.message : "リマインダーの作成に失敗しました"}`,
        );
      }
    }

    if (type === "cron") {
      const cronExpression = args.cronExpression as string | undefined;
      if (!cronExpression) {
        return textResult(
          "エラー: type='cron' の場合は cronExpression が必須です",
        );
      }

      try {
        const job = await controller.createReminder(content, {
          type: "cron",
          cronExpression,
        });

        return jsonResult({
          success: true,
          message: "繰り返しリマインダーを作成しました",
          reminder: {
            id: job.id,
            content,
            type: "cron",
            cronExpression,
            nextRunAt: job.nextRunAt?.toISOString(),
          },
        });
      } catch (error) {
        return textResult(
          `エラー: ${error instanceof Error ? error.message : "リマインダーの作成に失敗しました"}`,
        );
      }
    }

    return textResult(
      "エラー: type は 'once' または 'cron' を指定してください",
    );
  },
);
