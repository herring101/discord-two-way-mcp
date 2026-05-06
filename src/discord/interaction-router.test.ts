/**
 * interaction-router.ts のテスト (prefix dispatch / 未登録ハンドラ / 例外時)。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ButtonInteraction } from "discord.js";
import {
  clearButtonHandlers,
  handleButtonInteraction,
  registerButtonHandler,
} from "./interaction-router.js";

interface RecordedReply {
  content: string;
  flags?: number;
}

function makeInteraction(customId: string): {
  interaction: ButtonInteraction;
  replies: RecordedReply[];
} {
  const replies: RecordedReply[] = [];
  const interaction = {
    customId,
    replied: false,
    deferred: false,
    user: { id: "tester" },
    reply: async (opts: RecordedReply) => {
      replies.push(opts);
    },
  } as unknown as ButtonInteraction;
  return { interaction, replies };
}

describe("handleButtonInteraction", () => {
  beforeEach(() => {
    clearButtonHandlers();
  });
  afterEach(() => {
    clearButtonHandlers();
  });

  test("prefix で dispatch、payload は ':' 以降", async () => {
    const calls: Array<{ prefix: string; payload: string }> = [];
    registerButtonHandler("foo", async (_i, p) => {
      calls.push({ prefix: "foo", payload: p });
    });
    const { interaction } = makeInteraction("foo:abc-123");
    await handleButtonInteraction(interaction);
    expect(calls).toEqual([{ prefix: "foo", payload: "abc-123" }]);
  });

  test("':' なしの customId は payload 空文字", async () => {
    const calls: string[] = [];
    registerButtonHandler("simple", async (_i, p) => {
      calls.push(p);
    });
    const { interaction } = makeInteraction("simple");
    await handleButtonInteraction(interaction);
    expect(calls).toEqual([""]);
  });

  test("未登録の prefix は警告 reply を返す", async () => {
    const { interaction, replies } = makeInteraction("unknown:x");
    await handleButtonInteraction(interaction);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.content).toContain("unknown");
  });

  test("ハンドラが throw しても落ちず、エラー reply を返す", async () => {
    registerButtonHandler("boom", async () => {
      throw new Error("intentional");
    });
    const { interaction, replies } = makeInteraction("boom:y");
    await handleButtonInteraction(interaction); // ここで throw しない
    expect(replies).toHaveLength(1);
    expect(replies[0]?.content).toContain("エラー");
  });

  test("registerButtonHandler は同じ prefix を上書きできる", async () => {
    const log: string[] = [];
    registerButtonHandler("dup", async () => {
      log.push("first");
    });
    registerButtonHandler("dup", async () => {
      log.push("second");
    });
    const { interaction } = makeInteraction("dup:");
    await handleButtonInteraction(interaction);
    expect(log).toEqual(["second"]);
  });
});
