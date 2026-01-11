import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Client } from "discord.js";

/**
 * MCPツールの入力スキーマ定義
 */
export interface ToolInputSchema {
  type: "object";
  properties: Record<
    string,
    {
      type: string;
      description: string;
      enum?: string[];
      default?: unknown;
    }
  >;
  required?: string[];
}

/**
 * MCPツール定義
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

/**
 * MCPツールの戻り値
 */
export interface ToolResult {
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
}

/**
 * ツールハンドラの型
 */
export type ToolHandler = (
  client: Client,
  args: Record<string, unknown>,
) => Promise<ToolResult>;

/**
 * 登録されたツール
 */
interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
  requiresDiscord: boolean;
}

/**
 * ツールレジストリ
 * ツールの登録、検索、実行を管理
 */
class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  /**
   * ツールを登録
   */
  register(
    definition: ToolDefinition,
    handler: ToolHandler,
    options: { requiresDiscord?: boolean } = {},
  ): void {
    const { requiresDiscord = true } = options;
    this.tools.set(definition.name, {
      definition,
      handler,
      requiresDiscord,
    });
  }

  /**
   * 全ツール定義を取得
   */
  getDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  /**
   * ツールを実行
   */
  async execute(
    name: string,
    client: Client,
    args: Record<string, unknown>,
    isDiscordReady: boolean,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    if (tool.requiresDiscord && !isDiscordReady) {
      throw new McpError(
        ErrorCode.InternalError,
        "Discord client is not connected",
      );
    }

    return tool.handler(client, args);
  }

  /**
   * ツールが存在するか確認
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }
}

// シングルトンインスタンス
export const toolRegistry = new ToolRegistry();

/**
 * ツール登録のヘルパー関数
 */
export function defineTool(
  definition: ToolDefinition,
  handler: ToolHandler,
  options?: { requiresDiscord?: boolean },
): void {
  toolRegistry.register(definition, handler, options);
}

/**
 * JSON結果を返すヘルパー
 */
export function jsonResult(data: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

/**
 * プレーンテキスト結果を返すヘルパー
 */
export function textResult(text: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
}
