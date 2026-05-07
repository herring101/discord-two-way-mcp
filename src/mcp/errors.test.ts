/**
 * MCP tool / lifecycle 共通エラー型 (errors.ts) のテスト。
 */

import { describe, expect, test } from "bun:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  ToolExecutionError,
  ToolInputError,
  ToolPreconditionError,
  wrapToolExecutionError,
} from "./errors.js";

describe("ToolInputError", () => {
  test("McpError を継承し InvalidParams コードを持つ", () => {
    const e = new ToolInputError("bad input");
    expect(e).toBeInstanceOf(McpError);
    expect(e).toBeInstanceOf(ToolInputError);
    expect(e.code).toBe(ErrorCode.InvalidParams);
    expect(e.name).toBe("ToolInputError");
  });

  test("メッセージが保持される", () => {
    const e = new ToolInputError("userIds は必須です");
    expect(e.message).toContain("userIds は必須です");
  });
});

describe("ToolPreconditionError", () => {
  test("McpError を継承し InvalidRequest コードを持つ", () => {
    const e = new ToolPreconditionError("send target unset");
    expect(e).toBeInstanceOf(McpError);
    expect(e).toBeInstanceOf(ToolPreconditionError);
    expect(e.code).toBe(ErrorCode.InvalidRequest);
    expect(e.name).toBe("ToolPreconditionError");
  });
});

describe("ToolExecutionError", () => {
  test("McpError を継承し InternalError コードを持つ", () => {
    const e = new ToolExecutionError("discord call failed");
    expect(e).toBeInstanceOf(McpError);
    expect(e).toBeInstanceOf(ToolExecutionError);
    expect(e.code).toBe(ErrorCode.InternalError);
    expect(e.name).toBe("ToolExecutionError");
  });
});

describe("wrapToolExecutionError", () => {
  test("Error インスタンスのメッセージを取り込み Failed to ... 形式にする", () => {
    const e = wrapToolExecutionError(new Error("boom"), "send message");
    expect(e).toBeInstanceOf(ToolExecutionError);
    expect(e.code).toBe(ErrorCode.InternalError);
    expect(e.message).toContain("Failed to send message");
    expect(e.message).toContain("boom");
  });

  test("非 Error 値も String() 経由で取り込まれる", () => {
    const e = wrapToolExecutionError("plain string", "do thing");
    expect(e).toBeInstanceOf(ToolExecutionError);
    expect(e.message).toContain("Failed to do thing");
    expect(e.message).toContain("plain string");
  });

  test("McpError も同じく InternalError に正規化される (既存挙動互換)", () => {
    const inner = new ToolInputError("bad arg");
    const wrapped = wrapToolExecutionError(inner, "fetch messages");
    expect(wrapped.code).toBe(ErrorCode.InternalError);
    expect(wrapped.message).toContain("Failed to fetch messages");
    expect(wrapped.message).toContain("bad arg");
  });
});
