/**
 * ライフサイクル reducer のテスト
 */

import { describe, expect, test } from "bun:test";
import { reduce } from "./reducer.js";
import type { LifeState, UnreadSummaryWithDetails } from "./types.js";
import { toChannelId, toMessageId, toUnixMs, toUserId } from "./types.js";

// ヘルパー
const ch1 = toChannelId("channel-1");
const ch2 = toChannelId("channel-2");
const msg1 = toMessageId("message-1");
const user1 = toUserId("user-1");

describe("WAKE event", () => {
  test("OFF → AWAKE_NOT_WATCHING", () => {
    const state: LifeState = { mode: "OFF", focusChannelId: null };
    const result = reduce(state, { type: "WAKE" });

    expect(result.state.mode).toBe("AWAKE_NOT_WATCHING");
    expect(result.state.focusChannelId).toBeNull();
    expect(result.outputs).toHaveLength(0);
  });

  test("AWAKE_NOT_WATCHING → no change", () => {
    const state: LifeState = {
      mode: "AWAKE_NOT_WATCHING",
      focusChannelId: null,
    };
    const result = reduce(state, { type: "WAKE" });

    expect(result.state.mode).toBe("AWAKE_NOT_WATCHING");
  });

  test("AWAKE_WATCHING → no change", () => {
    const state: LifeState = { mode: "AWAKE_WATCHING", focusChannelId: ch1 };
    const result = reduce(state, { type: "WAKE" });

    expect(result.state.mode).toBe("AWAKE_WATCHING");
    expect(result.state.focusChannelId).toBe(ch1);
  });
});

describe("SLEEP event", () => {
  test("AWAKE_NOT_WATCHING → OFF", () => {
    const state: LifeState = {
      mode: "AWAKE_NOT_WATCHING",
      focusChannelId: null,
    };
    const result = reduce(state, { type: "SLEEP" });

    expect(result.state.mode).toBe("OFF");
    expect(result.state.focusChannelId).toBeNull();
  });

  test("AWAKE_WATCHING → no change (外側がSLEEPを投げない前提)", () => {
    const state: LifeState = { mode: "AWAKE_WATCHING", focusChannelId: ch1 };
    const result = reduce(state, { type: "SLEEP" });

    expect(result.state.mode).toBe("AWAKE_WATCHING");
  });

  test("OFF → no change", () => {
    const state: LifeState = { mode: "OFF", focusChannelId: null };
    const result = reduce(state, { type: "SLEEP" });

    expect(result.state.mode).toBe("OFF");
  });
});

describe("DISCORD_MESSAGE with mention/reply", () => {
  test("OFF + mention → AWAKE_WATCHING + outputs", () => {
    const state: LifeState = { mode: "OFF", focusChannelId: null };
    const result = reduce(state, {
      type: "DISCORD_MESSAGE",
      channelId: ch1,
      messageId: msg1,
      authorId: user1,
      isMentionOrReplyToAgent: true,
    });

    expect(result.state.mode).toBe("AWAKE_WATCHING");
    expect(result.state.focusChannelId).toBe(ch1);
    expect(result.outputs).toHaveLength(2);
    expect(result.outputs[0]).toEqual({
      type: "WATCHING_STARTED",
      focusChannelId: ch1,
    });
    expect(result.outputs[1]).toEqual({
      type: "FOCUS_MESSAGE",
      channelId: ch1,
      messageId: msg1,
    });
  });

  test("AWAKE_NOT_WATCHING + mention → AWAKE_WATCHING", () => {
    const state: LifeState = {
      mode: "AWAKE_NOT_WATCHING",
      focusChannelId: null,
    };
    const result = reduce(state, {
      type: "DISCORD_MESSAGE",
      channelId: ch1,
      messageId: msg1,
      authorId: user1,
      isMentionOrReplyToAgent: true,
    });

    expect(result.state.mode).toBe("AWAKE_WATCHING");
    expect(result.state.focusChannelId).toBe(ch1);
    expect(result.outputs).toHaveLength(2);
  });

  test("AWAKE_WATCHING + mention on different channel → focus switch", () => {
    const state: LifeState = { mode: "AWAKE_WATCHING", focusChannelId: ch1 };
    const result = reduce(state, {
      type: "DISCORD_MESSAGE",
      channelId: ch2,
      messageId: msg1,
      authorId: user1,
      isMentionOrReplyToAgent: true,
    });

    expect(result.state.focusChannelId).toBe(ch2);
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]).toEqual({
      type: "FOCUS_MESSAGE",
      channelId: ch2,
      messageId: msg1,
    });
  });
});

describe("DISCORD_MESSAGE without mention", () => {
  test("AWAKE_WATCHING + focus channel message → FOCUS_MESSAGE", () => {
    const state: LifeState = { mode: "AWAKE_WATCHING", focusChannelId: ch1 };
    const result = reduce(state, {
      type: "DISCORD_MESSAGE",
      channelId: ch1,
      messageId: msg1,
      authorId: user1,
      isMentionOrReplyToAgent: false,
    });

    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]).toEqual({
      type: "FOCUS_MESSAGE",
      channelId: ch1,
      messageId: msg1,
    });
  });

  test("AWAKE_WATCHING + other channel message → no output", () => {
    const state: LifeState = { mode: "AWAKE_WATCHING", focusChannelId: ch1 };
    const result = reduce(state, {
      type: "DISCORD_MESSAGE",
      channelId: ch2,
      messageId: msg1,
      authorId: user1,
      isMentionOrReplyToAgent: false,
    });

    expect(result.outputs).toHaveLength(0);
  });

  test("AWAKE_NOT_WATCHING + message → no output", () => {
    const state: LifeState = {
      mode: "AWAKE_NOT_WATCHING",
      focusChannelId: null,
    };
    const result = reduce(state, {
      type: "DISCORD_MESSAGE",
      channelId: ch1,
      messageId: msg1,
      authorId: user1,
      isMentionOrReplyToAgent: false,
    });

    expect(result.outputs).toHaveLength(0);
  });

  test("OFF + message → no output", () => {
    const state: LifeState = { mode: "OFF", focusChannelId: null };
    const result = reduce(state, {
      type: "DISCORD_MESSAGE",
      channelId: ch1,
      messageId: msg1,
      authorId: user1,
      isMentionOrReplyToAgent: false,
    });

    expect(result.outputs).toHaveLength(0);
  });
});

describe("PROMOTE_TO_WATCHING", () => {
  test("AWAKE_NOT_WATCHING → AWAKE_WATCHING", () => {
    const state: LifeState = {
      mode: "AWAKE_NOT_WATCHING",
      focusChannelId: null,
    };
    const result = reduce(state, {
      type: "PROMOTE_TO_WATCHING",
      focusChannelId: ch1,
    });

    expect(result.state.mode).toBe("AWAKE_WATCHING");
    expect(result.state.focusChannelId).toBe(ch1);
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]).toEqual({
      type: "WATCHING_STARTED",
      focusChannelId: ch1,
    });
  });

  test("OFF → no change", () => {
    const state: LifeState = { mode: "OFF", focusChannelId: null };
    const result = reduce(state, {
      type: "PROMOTE_TO_WATCHING",
      focusChannelId: ch1,
    });

    expect(result.state.mode).toBe("OFF");
    expect(result.outputs).toHaveLength(0);
  });
});

describe("SET_NOT_WATCHING", () => {
  test("AWAKE_WATCHING → AWAKE_NOT_WATCHING", () => {
    const state: LifeState = { mode: "AWAKE_WATCHING", focusChannelId: ch1 };
    const result = reduce(state, { type: "SET_NOT_WATCHING" });

    expect(result.state.mode).toBe("AWAKE_NOT_WATCHING");
    expect(result.state.focusChannelId).toBeNull();
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]).toEqual({ type: "WATCHING_ENDED" });
  });

  test("AWAKE_NOT_WATCHING → no change", () => {
    const state: LifeState = {
      mode: "AWAKE_NOT_WATCHING",
      focusChannelId: null,
    };
    const result = reduce(state, { type: "SET_NOT_WATCHING" });

    expect(result.state.mode).toBe("AWAKE_NOT_WATCHING");
    expect(result.outputs).toHaveLength(0);
  });
});

describe("SET_FOCUS_CHANNEL", () => {
  test("AWAKE_WATCHING → focus changed", () => {
    const state: LifeState = { mode: "AWAKE_WATCHING", focusChannelId: ch1 };
    const result = reduce(state, {
      type: "SET_FOCUS_CHANNEL",
      channelId: ch2,
    });

    expect(result.state.focusChannelId).toBe(ch2);
  });

  test("AWAKE_NOT_WATCHING → no change", () => {
    const state: LifeState = {
      mode: "AWAKE_NOT_WATCHING",
      focusChannelId: null,
    };
    const result = reduce(state, {
      type: "SET_FOCUS_CHANNEL",
      channelId: ch1,
    });

    expect(result.state.focusChannelId).toBeNull();
  });
});

describe("ACTIVITY_TICK", () => {
  test("AWAKE_WATCHING → ACTIVITY_DIGEST output", () => {
    const state: LifeState = { mode: "AWAKE_WATCHING", focusChannelId: ch1 };
    const summary: UnreadSummaryWithDetails[] = [
      {
        channelId: ch1,
        guildId: "g1",
        unreadCount: 5,
        messages: [],
      },
    ];
    const result = reduce(state, {
      type: "ACTIVITY_TICK",
      windowStartMs: toUnixMs(1000),
      windowEndMs: toUnixMs(2000),
      summary,
    });

    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]).toEqual({
      type: "ACTIVITY_DIGEST",
      windowStartMs: toUnixMs(1000),
      windowEndMs: toUnixMs(2000),
      summary,
    });
  });

  test("AWAKE_NOT_WATCHING → no output", () => {
    const state: LifeState = {
      mode: "AWAKE_NOT_WATCHING",
      focusChannelId: null,
    };
    const result = reduce(state, {
      type: "ACTIVITY_TICK",
      windowStartMs: toUnixMs(1000),
      windowEndMs: toUnixMs(2000),
      summary: [],
    });

    expect(result.outputs).toHaveLength(0);
  });
});
