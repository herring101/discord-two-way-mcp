/**
 * proxy 用の純粋ロジック群（テスト可能、I/O 副作用なし）。
 * Discord MCP child を spawn して仲介する HER-79 proxy で使う。
 */

import type { ToolDefinition } from "../mcp/tools/registry.js";

export const RESTART_TOOL_NAME = "restart_server";

export const RESTART_TOOL: ToolDefinition = {
  name: RESTART_TOOL_NAME,
  description:
    '内部の Discord MCP child process を kill → respawn → 再 initialize する。Claude 側の MCP 接続は維持される。restart 中の他 in-flight request は "server restarting" エラーで返る。',
  inputSchema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "再起動理由（任意、proxy.log に記録される）",
      },
    },
  },
};

/**
 * child の `tools/list` レスポンスに proxy 自身の tool（`restart_server`）を合算する。
 * 名前衝突した場合は proxy 側を優先（child のを除外）。
 */
export function mergeTools(
  childTools: ToolDefinition[],
  proxyTools: ToolDefinition[],
): ToolDefinition[] {
  const proxyNames = new Set(proxyTools.map((t) => t.name));
  return [...childTools.filter((t) => !proxyNames.has(t.name)), ...proxyTools];
}

/**
 * バッファに溜まった文字列から完全な行（`\n` 終端）を取り出す。
 * 残りの未完了部分は次回 chunk と結合して再パースするため remainder として返す。
 * 空行（trim 後 0 文字）は破棄する。
 */
export function extractLines(buffer: string): {
  lines: string[];
  remainder: string;
} {
  const lines: string[] = [];
  let remainder = buffer;
  let nlIdx = remainder.indexOf("\n");
  while (nlIdx !== -1) {
    const line = remainder.slice(0, nlIdx).trim();
    if (line.length > 0) lines.push(line);
    remainder = remainder.slice(nlIdx + 1);
    nlIdx = remainder.indexOf("\n");
  }
  return { lines, remainder };
}

/**
 * 指数バックオフの遅延 ms を返す。
 * attempt は 1 始まり。base = 1000ms、cap = 16000ms。
 */
export function backoffMs(attempt: number, base = 1000, cap = 16000): number {
  if (attempt <= 0) return 0;
  return Math.min(base * 2 ** (attempt - 1), cap);
}
