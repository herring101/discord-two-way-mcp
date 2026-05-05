/**
 * メッセージフォーマッタ
 * リアルタイム通知とツール取得で統一したプレーンテキスト形式を提供する
 */

import { isTrustedUser, wrapUntrusted } from "../security/index.js";

/**
 * フォーマット可能なメッセージの型
 */
/**
 * Embed内のフィールド
 */
export interface FormattableEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

/**
 * フォーマット可能なEmbed
 */
export interface FormattableEmbed {
  title?: string | null;
  description?: string | null;
  url?: string | null;
  color?: number | null;
  author?: { name: string; url?: string | null } | null;
  footer?: { text: string } | null;
  fields?: FormattableEmbedField[];
  image?: { url: string } | null;
  thumbnail?: { url: string } | null;
  timestamp?: string | null;
}

export interface FormattableMessage {
  id: string;
  channelId: string;
  channelName: string | null; // DMの場合null
  author: {
    id: string;
    username: string;
    displayName: string; // member.displayName or username
  };
  content: string;
  timestamp: Date;
  attachments?: Array<{
    filename: string;
    parsedContent?: string; // 解析成功時の内容
    parseError?: string; // 解析エラー時のメッセージ
  }>;
  embeds?: FormattableEmbed[];
  replyTo?: {
    messageId: string;
    content: string; // リプライ先の内容（截あり）
  };
  reactions?: Array<{
    emoji: string; // 絵文字（Unicodeまたはカスタム絵文字名）
    count: number; // リアクション数
  }>;
}

/**
 * 日付が同じ日かどうか判定
 */
export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * 日付セパレータを生成
 * 例: "=== 2026年1月11日 ==="
 */
export function formatDateSeparator(date: Date): string {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `=== ${year}年${month}月${day}日 ===`;
}

/**
 * 時刻を HH:MM 形式でフォーマット
 */
function formatTime(date: Date): string {
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

/**
 * 単一のEmbedをプレーンテキストにフォーマット
 */
function formatEmbed(embed: FormattableEmbed): string {
  const parts: string[] = [];

  if (embed.author?.name) {
    parts.push(
      `著者: ${embed.author.name}${embed.author.url ? ` (${embed.author.url})` : ""}`,
    );
  }

  if (embed.title) {
    const titleLine = embed.url ? `${embed.title} (${embed.url})` : embed.title;
    parts.push(titleLine);
  }

  if (embed.description) {
    parts.push(embed.description);
  }

  if (embed.fields && embed.fields.length > 0) {
    for (const field of embed.fields) {
      parts.push(`${field.name}: ${field.value}`);
    }
  }

  if (embed.image?.url) {
    parts.push(`[画像: ${embed.image.url}]`);
  }

  if (embed.thumbnail?.url) {
    parts.push(`[サムネイル: ${embed.thumbnail.url}]`);
  }

  if (embed.footer?.text) {
    parts.push(`— ${embed.footer.text}`);
  }

  if (embed.timestamp) {
    parts.push(`時刻: ${embed.timestamp}`);
  }

  return parts.join("\n");
}

/**
 * 単一メッセージをフォーマット
 *
 * 形式:
 * [#channel-name (ch:1234567890)] 表示名 (@username, u:268712085750415360) - 16:45 [msg:1459767163513602236]
 * メッセージ内容 (添付: image.png)
 *
 * untrusted ユーザーのメッセージは body 部分のみ <UNTRUSTED_BEGIN ...> ... <UNTRUSTED_END> で
 * ラップされる（ヘッダーは bot 生成のメタなので素のまま）。
 */
export async function formatMessage(msg: FormattableMessage): Promise<string> {
  // チャンネル部分
  const channelPart = msg.channelName
    ? `[#${msg.channelName} (ch:${msg.channelId})]`
    : "[DM]";

  // ユーザー部分
  const userPart = `${msg.author.displayName} (@${msg.author.username}, u:${msg.author.id})`;

  // 時刻
  const timePart = formatTime(msg.timestamp);

  // メッセージID
  const msgIdPart = `[msg:${msg.id}]`;

  // リプライ先情報
  const replyPart = msg.replyTo
    ? ` (reply to msg:${msg.replyTo.messageId} "${msg.replyTo.content}")`
    : "";

  // ヘッダー行
  const header = `${channelPart} ${userPart} - ${timePart} ${msgIdPart}${replyPart}`;

  // 内容行（添付ファイルがあれば追加）
  let body = msg.content;
  if (msg.attachments && msg.attachments.length > 0) {
    const attachmentTexts = msg.attachments.map((a) => {
      if (a.parsedContent) return `[${a.filename}] ${a.parsedContent}`;
      if (a.parseError) return `[${a.filename}] ⚠️ ${a.parseError}`;
      return `[${a.filename}]`;
    });
    const attachmentSection = `===添付ファイル===\n${attachmentTexts.join("\n")}`;
    body = body ? `${body}\n${attachmentSection}` : attachmentSection;
  }

  // Embed情報
  if (msg.embeds && msg.embeds.length > 0) {
    // 空でないembedのみフォーマット
    const embedTexts = msg.embeds
      .map((e) => formatEmbed(e))
      .filter((text) => text.length > 0);
    if (embedTexts.length > 0) {
      const embedSection =
        embedTexts.length === 1
          ? `===Embed===\n${embedTexts[0]}`
          : embedTexts
              .map((text, i) => `===Embed ${i + 1}===\n${text}`)
              .join("\n");
      body = body ? `${body}\n${embedSection}` : embedSection;
    }
  }

  // リアクション情報
  if (msg.reactions && msg.reactions.length > 0) {
    const reactionTexts = msg.reactions.map((r) => `[${r.emoji} ${r.count}]`);
    const reactionLine = reactionTexts.join(" ");
    body = body ? `${body}\n${reactionLine}` : reactionLine;
  }

  // untrusted ユーザーは body をラップ
  const trusted = await isTrustedUser(msg.author.id);
  const finalBody = trusted
    ? body
    : wrapUntrusted({
        source: `discord:user:${msg.author.id}`,
        body,
        meta: {
          username: msg.author.username,
          ...(msg.channelName ? { channel: msg.channelName } : {}),
        },
      });

  return `${header}\n${finalBody}`;
}

/**
 * 複数メッセージをフォーマット（日付セパレータを挿入）
 *
 * @param messages フォーマット対象のメッセージ配列（時系列順を想定）
 * @param initialDate 最初の日付セパレータ判定用の基準日（省略時は最初のメッセージで必ずセパレータを出力）
 */
export async function formatMessages(
  messages: FormattableMessage[],
  initialDate?: Date,
): Promise<string> {
  if (messages.length === 0) {
    return "(メッセージなし)";
  }

  const lines: string[] = [];
  let lastDate: Date | null = initialDate ?? null;

  for (const msg of messages) {
    // 日付が変わった場合はセパレータを挿入
    if (!lastDate || !isSameDay(lastDate, msg.timestamp)) {
      lines.push(formatDateSeparator(msg.timestamp));
    }
    lastDate = msg.timestamp;

    lines.push(await formatMessage(msg));
  }

  return lines.join("\n\n");
}
