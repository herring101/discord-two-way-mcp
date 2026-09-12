import { resolve } from "node:path";

const DISCORD_SNOWFLAKE_PATTERN = /^\d{17,20}$/;

export interface VoiceAutoJoinConfig {
  channelId: string;
  triggerUserIds: ReadonlySet<string>;
  recordUserIds: ReadonlySet<string>;
  recordingDirectory: string;
  leaveDelayMs: number;
  requireRecordingNotice: boolean;
}

type Environment = Record<string, string | undefined>;

function parseIdList(raw: string | undefined, fieldName: string): Set<string> {
  const ids = new Set(
    (raw ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );

  for (const id of ids) {
    if (!DISCORD_SNOWFLAKE_PATTERN.test(id)) {
      throw new Error(`${fieldName} contains an invalid Discord ID: ${id}`);
    }
  }

  return ids;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;

  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;

  throw new Error(`Invalid boolean value: ${raw}`);
}

function parseLeaveDelayMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 30_000;

  const delay = Number(raw);
  if (!Number.isSafeInteger(delay) || delay < 0 || delay > 10 * 60_000) {
    throw new Error(
      "DISCORD_VOICE_LEAVE_DELAY_MS must be an integer from 0 to 600000",
    );
  }
  return delay;
}

export function parseVoiceAutoJoinConfig(
  environment: Environment,
): VoiceAutoJoinConfig | null {
  const channelId = environment.DISCORD_VOICE_AUTOJOIN_CHANNEL_ID?.trim();
  const triggerIdsRaw = environment.DISCORD_VOICE_AUTOJOIN_USER_IDS?.trim();
  const recordingDirectory = environment.DISCORD_VOICE_RECORDING_DIR?.trim();

  const hasAnySetting = Boolean(
    channelId || triggerIdsRaw || recordingDirectory,
  );
  if (!hasAnySetting) return null;

  if (!channelId || !DISCORD_SNOWFLAKE_PATTERN.test(channelId)) {
    throw new Error(
      "DISCORD_VOICE_AUTOJOIN_CHANNEL_ID must be a Discord channel ID",
    );
  }

  const triggerUserIds = parseIdList(
    triggerIdsRaw,
    "DISCORD_VOICE_AUTOJOIN_USER_IDS",
  );
  if (triggerUserIds.size === 0) {
    throw new Error(
      "DISCORD_VOICE_AUTOJOIN_USER_IDS must contain at least one user ID",
    );
  }

  if (!recordingDirectory) {
    throw new Error("DISCORD_VOICE_RECORDING_DIR is required");
  }

  const recordUserIdsRaw = environment.DISCORD_VOICE_RECORD_USER_IDS?.trim();
  const recordUserIds = recordUserIdsRaw
    ? parseIdList(recordUserIdsRaw, "DISCORD_VOICE_RECORD_USER_IDS")
    : new Set(triggerUserIds);
  if (recordUserIds.size === 0) {
    throw new Error(
      "DISCORD_VOICE_RECORD_USER_IDS must contain at least one user ID",
    );
  }

  return {
    channelId,
    triggerUserIds,
    recordUserIds,
    recordingDirectory: resolve(recordingDirectory),
    leaveDelayMs: parseLeaveDelayMs(environment.DISCORD_VOICE_LEAVE_DELAY_MS),
    requireRecordingNotice: parseBoolean(
      environment.DISCORD_VOICE_REQUIRE_RECORDING_NOTICE,
      true,
    ),
  };
}

export function sanitizeRecordingFileComponent(value: string): string {
  const sanitized = value
    .normalize("NFKC")
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, "_")
    .replace(/^[_\-.]+|[_\-.]+$/g, "")
    .slice(0, 64);

  return sanitized || "user";
}
