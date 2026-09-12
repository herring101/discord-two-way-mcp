import { describe, expect, test } from "bun:test";
import {
  parseVoiceAutoJoinConfig,
  sanitizeRecordingFileComponent,
} from "./voice-auto-join-config.js";

describe("parseVoiceAutoJoinConfig", () => {
  test("returns null when voice auto-join is not configured", () => {
    expect(parseVoiceAutoJoinConfig({})).toBeNull();
  });

  test("parses a configured target and defaults record users to trigger users", () => {
    const config = parseVoiceAutoJoinConfig({
      DISCORD_VOICE_AUTOJOIN_CHANNEL_ID: "1246292469625126925",
      DISCORD_VOICE_AUTOJOIN_USER_IDS: "268712085750415360, 936808030861922335",
      DISCORD_VOICE_RECORDING_DIR: "./recordings",
    });

    expect(config).not.toBeNull();
    expect(config?.channelId).toBe("1246292469625126925");
    expect([...(config?.triggerUserIds ?? [])]).toEqual([
      "268712085750415360",
      "936808030861922335",
    ]);
    expect([...(config?.recordUserIds ?? [])]).toEqual([
      "268712085750415360",
      "936808030861922335",
    ]);
    expect(config?.recordingDirectory.endsWith("/recordings")).toBe(true);
    expect(config?.leaveDelayMs).toBe(30_000);
    expect(config?.requireRecordingNotice).toBe(true);
  });

  test("rejects partial or invalid configuration", () => {
    expect(() =>
      parseVoiceAutoJoinConfig({
        DISCORD_VOICE_AUTOJOIN_CHANNEL_ID: "not-an-id",
      }),
    ).toThrow("DISCORD_VOICE_AUTOJOIN_CHANNEL_ID");

    expect(() =>
      parseVoiceAutoJoinConfig({
        DISCORD_VOICE_AUTOJOIN_CHANNEL_ID: "1246292469625126925",
        DISCORD_VOICE_AUTOJOIN_USER_IDS: "",
        DISCORD_VOICE_RECORDING_DIR: "/tmp/recordings",
      }),
    ).toThrow("DISCORD_VOICE_AUTOJOIN_USER_IDS");
  });
});

describe("sanitizeRecordingFileComponent", () => {
  test("keeps readable Unicode names and removes path separators", () => {
    expect(sanitizeRecordingFileComponent("../へリン / test")).toBe(
      "へリン_test",
    );
  });
});
