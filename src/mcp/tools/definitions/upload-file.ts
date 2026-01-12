import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AttachmentBuilder, type Client } from "discord.js";
import { getLifecycleController } from "../../../discord/client.js";
import { fetchTextBasedChannel, wrapError } from "../../../discord/helpers.js";
import { defineTool, jsonResult } from "../registry.js";

// ツールを登録
defineTool(
  {
    name: "upload_file",
    description: "Discordチャンネルにファイルをアップロードします",
    inputSchema: {
      type: "object",
      properties: {
        channelId: {
          type: "string",
          description: "DiscordチャンネルID",
        },
        filePath: {
          type: "string",
          description: "アップロードするファイルの絶対パス",
        },
        message: {
          type: "string",
          description: "ファイルと一緒に送信するメッセージ（オプション）",
        },
      },
      required: ["channelId", "filePath"],
    },
  },
  async (client: Client, args: Record<string, unknown>) => {
    const channelId = args.channelId as string;
    const filePath = args.filePath as string;
    const message = args.message as string | undefined;

    try {
      // ファイルの存在確認
      try {
        await fs.access(filePath);
      } catch {
        throw new Error(`ファイルが見つかりません: ${filePath}`);
      }

      // ファイル情報取得
      const stats = await fs.stat(filePath);
      if (!stats.isFile()) {
        throw new Error(`パスはファイルではありません: ${filePath}`);
      }

      // ファイルサイズチェック（Discord制限: 25MB）
      const maxFileSize = 25 * 1024 * 1024;
      if (stats.size > maxFileSize) {
        throw new Error(
          `ファイルサイズがDiscordの制限(25MB)を超えています: ${Math.round(stats.size / 1024 / 1024)}MB`,
        );
      }

      // チャンネル取得
      const channel = await fetchTextBasedChannel(client, channelId);

      // ファイル読み込み
      const fileBuffer = await fs.readFile(filePath);
      const fileName = path.basename(filePath);

      // 添付ファイル作成
      const attachment = new AttachmentBuilder(fileBuffer, { name: fileName });

      // 送信
      const sentMessage = await channel.send({
        content: message ?? undefined,
        files: [attachment],
      });

      // focusチャンネルを切り替え
      const controller = getLifecycleController();
      if (controller) {
        await controller.setFocusChannel(channelId);
      }

      const uploadedAttachment = sentMessage.attachments.first();

      return jsonResult({
        success: true,
        messageId: sentMessage.id,
        channelId: sentMessage.channelId,
        fileName: fileName,
        fileSize: stats.size,
        url: uploadedAttachment?.url ?? null,
        timestamp: sentMessage.createdAt.toISOString(),
      });
    } catch (error) {
      throw wrapError(error, "upload file");
    }
  },
);
