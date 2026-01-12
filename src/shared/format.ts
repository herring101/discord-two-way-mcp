/**
 * メッセージフォーマッタ
 * リアルタイム通知とツール取得で統一したプレーンテキスト形式を提供する
 */

/**
 * フォーマット可能なメッセージの型
 */
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
  replyTo?: {
    messageId: string;
    content: string; // リプライ先の内容（截あり）
  };
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
 * 例: "--- 2026年1月11日 ---"
 */
export function formatDateSeparator(date: Date): string {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `--- ${year}年${month}月${day}日 ---`;
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
 * 単一メッセージをフォーマット
 *
 * 形式:
 * [#channel-name (ch:1234567890)] 表示名 (@username, u:268712085750415360) - 16:45 [msg:1459767163513602236]
 * メッセージ内容 (添付: image.png)
 */
export function formatMessage(msg: FormattableMessage): string {
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
  let content = msg.content;
  if (msg.attachments && msg.attachments.length > 0) {
    const attachmentTexts = msg.attachments.map((a) => {
      if (a.parsedContent) return `[${a.filename}] ${a.parsedContent}`;
      if (a.parseError) return `[${a.filename}] ⚠️ ${a.parseError}`;
      return `[${a.filename}]`;
    });
    const attachmentSection = `---添付ファイル---\n${attachmentTexts.join("\n")}`;
    content = content ? `${content}\n${attachmentSection}` : attachmentSection;
  }

  return `${header}\n${content}`;
}

/**
 * 複数メッセージをフォーマット（日付セパレータを挿入）
 *
 * @param messages フォーマット対象のメッセージ配列（時系列順を想定）
 * @param initialDate 最初の日付セパレータ判定用の基準日（省略時は最初のメッセージで必ずセパレータを出力）
 */
export function formatMessages(
  messages: FormattableMessage[],
  initialDate?: Date,
): string {
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

    lines.push(formatMessage(msg));
  }

  return lines.join("\n\n");
}
