/**
 * MCP tool / lifecycle 共通エラー型 (HER-84)
 *
 * 各 tool で散在していた `throw new Error()` / `throw new McpError(...)` を
 * ここに定義した派生クラスに集約する。
 *
 * すべて MCP SDK の `McpError` を継承するため、MCP プロトコル経由で
 * クライアントに伝搬する際に code が正しく付与される。
 *
 * 使い分け:
 * - {@link ToolInputError}       - tool の引数 (args) が不正                (InvalidParams)
 * - {@link ToolPreconditionError} - 前提状態が未充足 (例: 送信先未設定)     (InvalidRequest)
 * - {@link ToolExecutionError}   - 実行時の内部失敗 (Discord/DB 等)         (InternalError)
 *
 * `wrapToolExecutionError` は HER 以前に `discord/helpers.ts#wrapError` が
 * 担っていた「想定外 error → ToolExecutionError 化」のヘルパ。
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

/**
 * tool の引数 (args) が不正な場合に投げる。
 * 例: 必須フィールド欠損、enum 範囲外、形式違反、空配列。
 * MCP error code: `InvalidParams`
 */
export class ToolInputError extends McpError {
  constructor(message: string) {
    super(ErrorCode.InvalidParams, message);
    this.name = "ToolInputError";
  }
}

/**
 * tool 実行に必要な前提状態が満たされていない場合に投げる。
 * 例: `send_message` を `set_send_target` 未呼び出しで叩いた、Discord 未接続。
 * MCP error code: `InvalidRequest`
 */
export class ToolPreconditionError extends McpError {
  constructor(message: string) {
    super(ErrorCode.InvalidRequest, message);
    this.name = "ToolPreconditionError";
  }
}

/**
 * tool 実行中の内部処理が失敗した場合に投げる。
 * 例: Discord API 呼び出し失敗、DB エラー、ファイル I/O 失敗、サイズ超過。
 * MCP error code: `InternalError`
 */
export class ToolExecutionError extends McpError {
  constructor(message: string) {
    super(ErrorCode.InternalError, message);
    this.name = "ToolExecutionError";
  }
}

/**
 * catch 節で受けた任意の `error` を {@link ToolExecutionError} に正規化する。
 *
 * 旧 `discord/helpers.ts#wrapError` の後継。動作は同じ:
 * `Failed to ${action}: ${error.message}` という形の InternalError を返す。
 *
 * 注意: 内側で投げた MCP 系エラー (ToolInputError 等) もここで InternalError に
 * 丸められる。意図して維持している（既存挙動互換）。
 */
export function wrapToolExecutionError(
  error: unknown,
  action: string,
): ToolExecutionError {
  const message = error instanceof Error ? error.message : String(error);
  return new ToolExecutionError(`Failed to ${action}: ${message}`);
}
