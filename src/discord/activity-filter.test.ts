import { describe, expect, test } from "bun:test";
import {
  filterIgnoredActivityChannels,
  parseIgnoredChannelIds,
} from "./activity-filter.js";

describe("parseIgnoredChannelIds", () => {
  test("returns empty set for empty input", () => {
    expect(parseIgnoredChannelIds(undefined).size).toBe(0);
    expect(parseIgnoredChannelIds("").size).toBe(0);
  });

  test("parses comma-separated channel ids", () => {
    expect([...parseIgnoredChannelIds("123, 456,,789")]).toEqual([
      "123",
      "456",
      "789",
    ]);
  });

  test("parses JSON array channel ids", () => {
    expect([...parseIgnoredChannelIds('["123","456",789]')]).toEqual([
      "123",
      "456",
    ]);
  });
});

describe("filterIgnoredActivityChannels", () => {
  test("keeps all summaries when no channel is ignored", () => {
    const summary = [
      { channelId: "a", guildId: "g", unreadCount: 1, messages: [] },
    ];

    expect(filterIgnoredActivityChannels(summary, new Set())).toBe(summary);
  });

  test("removes ignored channels from activity summary", () => {
    const summary = [
      { channelId: "a", guildId: "g", unreadCount: 1, messages: [] },
      { channelId: "b", guildId: "g", unreadCount: 2, messages: [] },
    ];

    expect(filterIgnoredActivityChannels(summary, new Set(["a"]))).toEqual([
      { channelId: "b", guildId: "g", unreadCount: 2, messages: [] },
    ]);
  });
});
