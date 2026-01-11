import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  ChannelType,
  type Client,
  DMChannel,
  type Message,
  NewsChannel,
  TextChannel,
  ThreadChannel,
} from "discord.js";

type SendableChannel = TextChannel | ThreadChannel | NewsChannel | DMChannel;

export interface MessageData {
  id: string;
  author: {
    username: string;
    id: string;
    bot: boolean;
  };
  content: string;
  timestamp: string;
  attachments: AttachmentData[];
  embeds: EmbedData[];
}

export interface AttachmentData {
  id: string;
  url: string;
  filename: string;
  contentType: string | null;
  size: number;
}

export interface EmbedData {
  title: string | null;
  description: string | null;
  url: string | null;
}

export interface ChannelData {
  id: string;
  name: string;
  type: string;
  position: number;
}

export async function fetchTextBasedChannel(
  client: Client,
  channelId: string,
): Promise<SendableChannel> {
  const channel = await client.channels.fetch(channelId);
  if (!channel) {
    throw new McpError(ErrorCode.InvalidParams, "Channel not found");
  }

  if (
    channel instanceof TextChannel ||
    channel instanceof ThreadChannel ||
    channel instanceof NewsChannel ||
    channel instanceof DMChannel
  ) {
    return channel;
  }

  throw new McpError(
    ErrorCode.InvalidParams,
    "Channel is not a text-based channel that supports messaging",
  );
}

export function transformMessage(msg: Message): MessageData {
  return {
    id: msg.id,
    author: {
      username: msg.author.username,
      id: msg.author.id,
      bot: msg.author.bot,
    },
    content: msg.content,
    timestamp: msg.createdAt.toISOString(),
    attachments: msg.attachments.map((att) => ({
      id: att.id,
      url: att.url,
      filename: att.name || "unknown",
      contentType: att.contentType,
      size: att.size,
    })),
    embeds: msg.embeds.map((embed) => ({
      title: embed.title,
      description: embed.description,
      url: embed.url,
    })),
  };
}

export function filterTextChannels(channels: {
  cache: Map<
    string,
    { type: ChannelType; id: string; name: string; position?: number }
  >;
}): ChannelData[] {
  return [...channels.cache.values()]
    .filter(
      (channel) =>
        channel.type === ChannelType.GuildText ||
        channel.type === ChannelType.PublicThread ||
        channel.type === ChannelType.PrivateThread,
    )
    .map((channel) => ({
      id: channel.id,
      name: channel.name,
      type: channel.type === ChannelType.GuildText ? "text" : "thread",
      position: channel.position || 0,
    }))
    .sort((a, b) => a.position - b.position);
}

export function wrapError(error: unknown, action: string): McpError {
  return new McpError(
    ErrorCode.InternalError,
    `Failed to ${action}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

export function validateMessageContent(content: string | undefined): string {
  if (!content || content.trim().length === 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "Message content cannot be empty",
    );
  }
  return content;
}

export function validateAndLimitNumber(
  value: number | undefined,
  defaultValue: number,
  max: number,
): number {
  const num = value || defaultValue;
  return Math.min(num, max);
}

export function ensureDiscordConnected(isConnected: boolean): void {
  if (!isConnected) {
    throw new McpError(
      ErrorCode.InternalError,
      "Discord client is not connected",
    );
  }
}
