import {
  ChannelType,
  type Client,
  type GuildBasedChannel,
  type GuildChannelCreateOptions,
} from "discord.js";
import { appendTraceEvent } from "../../../shared/trace-audit.js";
import { ToolInputError, wrapToolExecutionError } from "../../errors.js";
import { defineTool, jsonResult } from "../registry.js";
import {
  validateActionEnum,
  validateOptionalString,
  validateRequiredString,
} from "../validators.js";

const CHANNEL_TYPES = ["text", "forum", "category"] as const;

type ChannelTypeInput = (typeof CHANNEL_TYPES)[number];

function toDiscordChannelType(type: ChannelTypeInput): ChannelType {
  switch (type) {
    case "text":
      return ChannelType.GuildText;
    case "forum":
      return ChannelType.GuildForum;
    case "category":
      return ChannelType.GuildCategory;
  }
}

function serializeGuildChannel(channel: GuildBasedChannel): {
  id: string;
  name: string;
  type: number;
  parentId: string | null;
  guildId: string;
  position: number;
} {
  return {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    parentId: "parentId" in channel ? channel.parentId : null,
    guildId: channel.guild.id,
    position: "rawPosition" in channel ? channel.rawPosition : 0,
  };
}

function validateChannelName(value: unknown): string {
  const name = validateRequiredString(value, "name").trim();
  if (name.length === 0) {
    throw new ToolInputError("name cannot be empty");
  }
  if (name.length > 100) {
    throw new ToolInputError("name must be 100 characters or fewer");
  }
  return name;
}

defineTool(
  {
    name: "create_channel",
    description:
      "Discordサーバーにカテゴリ・テキストチャンネル・フォーラムチャンネルを作成します。Botにチャンネル管理権限が必要です。",
    inputSchema: {
      type: "object",
      properties: {
        guildId: {
          type: "string",
          description: "作成先 Discord サーバー ID",
        },
        name: {
          type: "string",
          description: "作成するチャンネル名",
        },
        type: {
          type: "string",
          description: "作成する種類: text / forum / category",
          enum: [...CHANNEL_TYPES],
        },
        parentId: {
          type: "string",
          description:
            "親カテゴリID（text/forum の場合のみ任意。category の場合は無視されます）",
        },
        topic: {
          type: "string",
          description: "チャンネル説明・トピック（text/forum の場合のみ任意）",
        },
        reason: {
          type: "string",
          description: "Discord監査ログ用の理由（任意）",
        },
      },
      required: ["guildId", "name", "type"],
    },
  },
  async (client: Client, args: Record<string, unknown>) => {
    const guildId = validateRequiredString(args.guildId, "guildId");
    const name = validateChannelName(args.name);
    const inputType = validateActionEnum(args.type, CHANNEL_TYPES, "type");
    const parentId =
      inputType === "category"
        ? undefined
        : validateOptionalString(args.parentId, "parentId");
    const topic =
      inputType === "category"
        ? undefined
        : validateOptionalString(args.topic, "topic");
    const reason = validateOptionalString(args.reason, "reason");

    try {
      const guild = await client.guilds.fetch(guildId);
      const channel = await guild.channels.create({
        name,
        type: toDiscordChannelType(inputType),
        parent: parentId,
        topic,
        reason,
      } as GuildChannelCreateOptions);

      appendTraceEvent({
        event: "create_channel",
        guildId,
        channelId: channel.id,
        channelName: channel.name,
        channelType: inputType,
        success: true,
      });

      return jsonResult({
        success: true,
        channel: serializeGuildChannel(channel),
      });
    } catch (error) {
      appendTraceEvent({
        event: "create_channel",
        guildId,
        channelName: name,
        channelType: inputType,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw wrapToolExecutionError(error, "create channel");
    }
  },
);

defineTool(
  {
    name: "edit_channel",
    description:
      "Discordチャンネルの名前・親カテゴリ・トピックを変更します。Botにチャンネル管理権限が必要です。",
    inputSchema: {
      type: "object",
      properties: {
        channelId: {
          type: "string",
          description: "編集する Discord チャンネル ID",
        },
        name: {
          type: "string",
          description: "新しいチャンネル名（任意）",
        },
        parentId: {
          type: "string",
          description:
            "移動先カテゴリID。カテゴリから外す場合は現状未対応（任意）",
        },
        topic: {
          type: "string",
          description: "新しいチャンネルトピック（任意）",
        },
        reason: {
          type: "string",
          description: "Discord監査ログ用の理由（任意）",
        },
      },
      required: ["channelId"],
    },
  },
  async (client: Client, args: Record<string, unknown>) => {
    const channelId = validateRequiredString(args.channelId, "channelId");
    const name =
      args.name === undefined || args.name === null
        ? undefined
        : validateChannelName(args.name);
    const parentId = validateOptionalString(args.parentId, "parentId");
    const topic = validateOptionalString(args.topic, "topic");
    const reason = validateOptionalString(args.reason, "reason");

    if (!name && !parentId && topic === undefined) {
      throw new ToolInputError(
        "name / parentId / topic の少なくとも1つを指定してください",
      );
    }

    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !("guild" in channel) || !("edit" in channel)) {
        throw new ToolInputError("channelId must be a guild channel");
      }

      const edited = await channel.edit({
        name,
        parent: parentId,
        topic,
        reason,
      });

      appendTraceEvent({
        event: "edit_channel",
        channelId,
        channelName: edited.name,
        parentId: "parentId" in edited ? edited.parentId : null,
        success: true,
      });

      return jsonResult({
        success: true,
        channel: serializeGuildChannel(edited),
      });
    } catch (error) {
      appendTraceEvent({
        event: "edit_channel",
        channelId,
        channelName: name,
        parentId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw wrapToolExecutionError(error, "edit channel");
    }
  },
);
