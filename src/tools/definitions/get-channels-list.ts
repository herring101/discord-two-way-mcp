import type { Client } from "discord.js";
import { filterTextChannels, wrapError } from "../../utils/discord.js";
import { defineTool, jsonResult } from "../registry.js";

// ツールを登録
defineTool(
  {
    name: "get_channels_list",
    description:
      "Botが参加している全ギルドのテキストチャンネル一覧を取得します。ギルドIDと名前も含まれます。",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  async (client: Client) => {
    try {
      const guilds = client.guilds.cache;
      const result: Array<{
        guildId: string;
        guildName: string;
        channels: Array<{
          id: string;
          name: string;
          type: string;
          position: number;
        }>;
      }> = [];

      for (const guild of guilds.values()) {
        const channels = filterTextChannels(guild.channels);
        result.push({
          guildId: guild.id,
          guildName: guild.name,
          channels,
        });
      }

      return jsonResult({ guilds: result });
    } catch (error) {
      throw wrapError(error, "fetch channels list");
    }
  },
);
