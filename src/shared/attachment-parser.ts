/**
 * 添付ファイル解析モジュール
 * Gemini 2.5 Flash Lite を使用して添付ファイルを解析し、日本語要約を生成
 */
import { GoogleGenAI } from "@google/genai";
import { getLogger } from "./logger.js";

const logger = getLogger("attachment-parser");

// API Key がある場合のみ初期化
const apiKey = process.env.GEMINI_API_KEY;
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

if (ai) {
  logger.info("Gemini API initialized for attachment parsing");
} else {
  logger.info("GEMINI_API_KEY not set, attachment parsing disabled");
}

/**
 * 対応するMIMEタイプのセット
 */
const SUPPORTED_MIME_TYPES = new Set([
  // 画像
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  // 動画
  "video/mp4",
  "video/webm",
  "video/quicktime",
  // 音声
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  // PDF
  "application/pdf",
  // テキスト
  "text/plain",
  "text/csv",
  "text/html",
]);

/**
 * MIMEタイプが対応しているか判定
 */
function isSupportedMimeType(
  contentType: string | null,
): contentType is string {
  if (!contentType) return false;
  // "image/jpeg; charset=utf-8" のようなケースに対応
  const mimeType = contentType.split(";")[0]?.trim();
  return mimeType ? SUPPORTED_MIME_TYPES.has(mimeType) : false;
}

/**
 * 解析結果の型
 */
export type ParseResult =
  | { parsed: true; content: string }
  | { parsed: false; error?: string };

/**
 * 添付ファイルを解析してテキスト要約を返す
 *
 * @param url 添付ファイルのURL
 * @param contentType MIMEタイプ
 * @param filename ファイル名
 * @returns 解析結果
 */
export async function parseAttachment(
  url: string,
  contentType: string | null,
  filename: string,
): Promise<ParseResult> {
  // API Keyがない場合は解析をスキップ
  if (!ai) {
    return { parsed: false };
  }

  // 対応形式かチェック
  if (!isSupportedMimeType(contentType)) {
    logger.debug(`Unsupported content type: ${contentType} for ${filename}`);
    return { parsed: false };
  }

  try {
    logger.debug(`Parsing attachment: ${filename} (${contentType})`);

    // URLからファイルをダウンロード
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const base64Data = Buffer.from(arrayBuffer).toString("base64");

    // MIMEタイプからセミコロン以降を除去
    const mimeType = contentType.split(";")[0]?.trim() ?? contentType;

    // Gemini API 呼び出し
    const result = await ai.models.generateContent({
      model: "gemini-2.5-flash-lite",
      contents: [
        {
          inlineData: {
            mimeType,
            data: base64Data,
          },
        },
        {
          text: `以下の添付ファイルの内容を日本語で300文字程度で要約してください。
ファイル名: ${filename}`,
        },
      ],
    });

    const text = result.text;
    if (text) {
      logger.debug(`Successfully parsed ${filename}: ${text.slice(0, 50)}...`);
      return { parsed: true, content: text };
    }

    return { parsed: false, error: "解析結果が空です" };
  } catch (error) {
    logger.error(`Attachment parsing failed for ${filename}:`, error);
    const errorMessage =
      error instanceof Error ? error.message : "不明なエラー";
    return { parsed: false, error: `解析エラー: ${errorMessage}` };
  }
}

/**
 * 添付ファイル解析が有効かどうか
 */
export function isParsingEnabled(): boolean {
  return ai !== null;
}
