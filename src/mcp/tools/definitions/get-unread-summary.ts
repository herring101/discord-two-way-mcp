/**
 * 未読サマリー取得ツール
 */

import type { Client } from "discord.js";
import { getPrismaClient } from "../../../db/client.js";
import {
  formatUnreadSummary,
  getUnreadSummary,
} from "../../../lifecycle/unread.js";
import { defineTool, textResult } from "../registry.js";

defineTool(
  {
    name: "get_unread_summary",
    description:
      "全チャンネルの未読メッセージ数サマリーを取得します。未読の多いチャンネルから順に表示されます。",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  async (_client: Client, _args: Record<string, unknown>) => {
    const prisma = getPrismaClient();
    const summaries = await getUnreadSummary(prisma);
    const summary = formatUnreadSummary(summaries);
    return textResult(summary ?? "未読メッセージはありません。");
  },
);
