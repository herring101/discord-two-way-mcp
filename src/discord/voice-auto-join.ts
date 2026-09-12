import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type AudioReceiveStream,
  EndBehaviorType,
  entersState,
  joinVoiceChannel,
  type VoiceConnection,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import {
  ChannelType,
  type Client,
  Events,
  type VoiceChannel,
  type VoiceState,
} from "discord.js";
import OpusScript from "opusscript";
import { getLogger } from "../shared/logger.js";
import {
  sanitizeRecordingFileComponent,
  type VoiceAutoJoinConfig,
} from "./voice-auto-join-config.js";
import { WavTrackWriter } from "./wav-track-writer.js";

const logger = getLogger("voice-auto-join");
const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BITS_PER_SAMPLE = 16;
const CONNECT_TIMEOUT_MS = 20_000;
const START_RETRY_DELAY_MS = 60_000;

interface TrackManifest {
  userId: string;
  displayName: string;
  file: string;
  segment: number;
  startedAt: string;
  endedAt: string | null;
}

interface SessionManifest {
  schemaVersion: 1;
  status: "recording" | "completed";
  guildId: string;
  channelId: string;
  triggerUserIds: string[];
  recordUserIds: string[];
  startedAt: string;
  endedAt: string | null;
  tracks: TrackManifest[];
}

interface RecordingSession {
  directory: string;
  manifestPath: string;
  startedAtMs: number;
  manifest: SessionManifest;
}

interface ActiveTrack {
  userId: string;
  subscription: AudioReceiveStream;
  decoder: OpusScript;
  writer: WavTrackWriter;
  manifest: TrackManifest;
}

export class VoiceAutoJoinController {
  private connection: VoiceConnection | null = null;
  private channel: VoiceChannel | null = null;
  private session: RecordingSession | null = null;
  private readonly tracks = new Map<string, ActiveTrack>();
  private readonly segmentCounts = new Map<string, number>();
  private leaveTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private operationChain: Promise<void> = Promise.resolve();
  private started = false;

  constructor(
    private readonly client: Client,
    private readonly config: VoiceAutoJoinConfig,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.client.on(Events.VoiceStateUpdate, this.handleVoiceStateUpdate);

    const channel = await this.client.channels.fetch(this.config.channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      throw new Error(
        `Configured voice channel ${this.config.channelId} was not found or is not a guild voice channel`,
      );
    }
    this.channel = channel;

    logger.info(
      `Watching voice channel ${channel.name} (${channel.id}) for ${this.config.triggerUserIds.size} trigger user(s)`,
    );
    this.queueReconcile("startup");
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.client.off(Events.VoiceStateUpdate, this.handleVoiceStateUpdate);
    this.clearLeaveTimer();
    this.clearRetryTimer();

    await this.operationChain;
    await this.stopSession("Discord connection shutting down");
  }

  private readonly handleVoiceStateUpdate = (
    oldState: VoiceState,
    newState: VoiceState,
  ): void => {
    const affectsConfiguredChannel =
      oldState.channelId === this.config.channelId ||
      newState.channelId === this.config.channelId;
    const affectsBot = newState.id === this.client.user?.id;
    if (!affectsConfiguredChannel && !affectsBot) return;

    this.queueReconcile(
      `voiceStateUpdate:${newState.id}:${oldState.channelId ?? "none"}->${newState.channelId ?? "none"}`,
    );
  };

  private queueReconcile(reason: string): void {
    this.operationChain = this.operationChain
      .then(() => this.reconcile(reason))
      .catch((error) => {
        logger.error(`Failed to reconcile voice state (${reason}):`, error);
      });
  }

  private async reconcile(reason: string): Promise<void> {
    if (!this.started || !this.channel) return;

    const presentTriggerIds = [...this.config.triggerUserIds].filter((id) =>
      this.channel?.members.has(id),
    );

    if (presentTriggerIds.length === 0) {
      this.clearRetryTimer();
      await this.syncTracksWithChannel();
      this.scheduleLeave(reason);
      return;
    }

    this.clearLeaveTimer();
    if (!this.session) {
      if (this.retryTimer) return;
      const started = await this.startSession(presentTriggerIds);
      if (!started) {
        this.scheduleRetry();
        return;
      }
    }

    await this.syncTracksWithChannel();
  }

  private async startSession(presentTriggerIds: string[]): Promise<boolean> {
    const channel = this.channel;
    if (!channel) return false;
    if (!channel.joinable) {
      logger.error(
        `Cannot join voice channel ${channel.id}; check View Channel and Connect permissions`,
      );
      return false;
    }

    logger.info(
      `Joining ${channel.name}; trigger user(s) present: ${presentTriggerIds.join(", ")}`,
    );

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });
    this.connection = connection;
    connection.on("error", (error) => {
      logger.error("Discord voice connection error:", error);
    });

    try {
      await entersState(
        connection,
        VoiceConnectionStatus.Ready,
        CONNECT_TIMEOUT_MS,
      );
    } catch (error) {
      logger.error("Voice connection did not become ready:", error);
      connection.destroy();
      this.connection = null;
      return false;
    }

    const botName = this.client.user?.username ?? "Bot";
    const noticeSent = await this.sendRecordingNotice(
      `🔴 録音を開始します。${botName}はこのVCで、指定ユーザー ${[
        ...this.config.recordUserIds,
      ]
        .map((id) => `<@${id}>`)
        .join("、")} の音声のみを録音します。`,
    );
    if (this.config.requireRecordingNotice && !noticeSent) {
      logger.error(
        "Recording notice could not be posted, so recording was not started",
      );
      connection.destroy();
      this.connection = null;
      return false;
    }

    const now = new Date();
    const sessionName = now
      .toISOString()
      .replace(/[:]/g, "-")
      .replace(/\.\d{3}Z$/, "Z");
    const directory = join(this.config.recordingDirectory, sessionName);
    await mkdir(directory, { recursive: true });

    this.segmentCounts.clear();
    this.session = {
      directory,
      manifestPath: join(directory, "session.json"),
      startedAtMs: now.getTime(),
      manifest: {
        schemaVersion: 1,
        status: "recording",
        guildId: channel.guild.id,
        channelId: channel.id,
        triggerUserIds: [...this.config.triggerUserIds],
        recordUserIds: [...this.config.recordUserIds],
        startedAt: now.toISOString(),
        endedAt: null,
        tracks: [],
      },
    };
    await this.writeManifest();

    logger.info(`Recording session started in ${directory}`);
    return true;
  }

  private async stopSession(reason: string): Promise<void> {
    this.clearLeaveTimer();
    this.clearRetryTimer();

    for (const userId of [...this.tracks.keys()]) {
      await this.stopTrack(userId);
    }

    const session = this.session;
    if (session) {
      session.manifest.status = "completed";
      session.manifest.endedAt = new Date().toISOString();
      await this.writeManifest();
      await this.sendRecordingNotice(`⏹️ 録音を終了しました。理由: ${reason}`);
      logger.info(`Recording session completed: ${session.directory}`);
      this.session = null;
    }

    const connection = this.connection;
    this.connection = null;
    if (
      connection &&
      connection.state.status !== VoiceConnectionStatus.Destroyed
    ) {
      connection.destroy();
    }
  }

  private async syncTracksWithChannel(): Promise<void> {
    const channel = this.channel;
    if (!channel || !this.session || !this.connection) return;

    const shouldRecord = new Set(
      [...this.config.recordUserIds].filter((id) => channel.members.has(id)),
    );

    for (const userId of [...this.tracks.keys()]) {
      if (!shouldRecord.has(userId)) {
        await this.stopTrack(userId);
      }
    }

    for (const userId of shouldRecord) {
      if (!this.tracks.has(userId)) {
        await this.startTrack(userId);
      }
    }
  }

  private async startTrack(userId: string): Promise<void> {
    const channel = this.channel;
    const connection = this.connection;
    const session = this.session;
    if (!channel || !connection || !session) return;

    const member = channel.members.get(userId);
    if (!member) return;

    const displayName = member.displayName || member.user.username;
    const segment = (this.segmentCounts.get(userId) ?? 0) + 1;
    this.segmentCounts.set(userId, segment);

    const safeName = sanitizeRecordingFileComponent(displayName);
    const fileName = `${userId}-${safeName}-${String(segment).padStart(2, "0")}.wav`;
    const filePath = join(session.directory, fileName);
    const startedAt = new Date();
    const manifest: TrackManifest = {
      userId,
      displayName,
      file: basename(filePath),
      segment,
      startedAt: startedAt.toISOString(),
      endedAt: null,
    };

    const writer = new WavTrackWriter(filePath, {
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      bitsPerSample: BITS_PER_SAMPLE,
    });
    const decoder = new OpusScript(
      SAMPLE_RATE,
      CHANNELS,
      OpusScript.Application.AUDIO,
    );
    const subscription = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });

    const track: ActiveTrack = {
      userId,
      subscription,
      decoder,
      writer,
      manifest,
    };
    this.tracks.set(userId, track);
    session.manifest.tracks.push(manifest);

    subscription.on("data", (packet: Buffer) => {
      try {
        const pcm = decoder.decode(packet);
        const elapsedMs = Date.now() - session.startedAtMs;
        writer.appendPcmAt(pcm, elapsedMs);
      } catch (error) {
        logger.error(`Failed to decode audio for user ${userId}:`, error);
      }
    });
    subscription.on("error", (error) => {
      logger.error(`Audio receive stream failed for user ${userId}:`, error);
    });

    await this.writeManifest();
    logger.info(
      `Recording track started for ${displayName} (${userId}): ${filePath}`,
    );
  }

  private async stopTrack(userId: string): Promise<void> {
    const track = this.tracks.get(userId);
    const session = this.session;
    if (!track || !session) return;
    this.tracks.delete(userId);

    track.subscription.destroy();
    track.decoder.delete();
    track.writer.close(Date.now() - session.startedAtMs);
    track.manifest.endedAt = new Date().toISOString();

    await this.writeManifest();
    logger.info(`Recording track completed for user ${userId}`);
  }

  private async writeManifest(): Promise<void> {
    const session = this.session;
    if (!session) return;

    await writeFile(
      session.manifestPath,
      `${JSON.stringify(session.manifest, null, 2)}\n`,
      "utf8",
    );
  }

  private async sendRecordingNotice(content: string): Promise<boolean> {
    const channel = this.channel;
    if (!channel || !channel.isSendable()) {
      logger.error(
        `Voice channel ${this.config.channelId} does not support recording notices`,
      );
      return false;
    }

    try {
      await channel.send({
        content,
        allowedMentions: { users: [...this.config.recordUserIds] },
      });
      return true;
    } catch (error) {
      logger.error("Failed to send recording notice:", error);
      return false;
    }
  }

  private scheduleLeave(reason: string): void {
    if (!this.session || this.leaveTimer) return;

    logger.info(
      `No trigger users remain; leaving in ${this.config.leaveDelayMs}ms`,
    );
    this.leaveTimer = setTimeout(() => {
      this.leaveTimer = null;
      this.operationChain = this.operationChain
        .then(() =>
          this.stopSession(
            `対象ユーザーが全員退出（${this.config.leaveDelayMs / 1_000}秒待機）`,
          ),
        )
        .catch((error) => {
          logger.error(`Failed to stop voice session (${reason}):`, error);
        });
    }, this.config.leaveDelayMs);
  }

  private scheduleRetry(): void {
    if (this.retryTimer || !this.started) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.queueReconcile("retry-after-start-failure");
    }, START_RETRY_DELAY_MS);
  }

  private clearLeaveTimer(): void {
    if (!this.leaveTimer) return;
    clearTimeout(this.leaveTimer);
    this.leaveTimer = null;
  }

  private clearRetryTimer(): void {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}
