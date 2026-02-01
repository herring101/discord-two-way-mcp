// ツールを登録するためのエントリポイント
// 各ツールファイルをインポートするだけで自動登録される

import "./definitions/add-reaction.js";
import "./definitions/create-reminder.js";
import "./definitions/delete-reminder.js";
import "./definitions/end-activity.js";
import "./definitions/get-channel-messages.js";
import "./definitions/get-channels-list.js";
import "./definitions/get-unread-summary.js";
import "./definitions/import-guild-messages.js";
import "./definitions/list-reminders.js";
import "./definitions/reply-to-message.js";
import "./definitions/search-messages.js";
import "./definitions/send-message.js";
import "./definitions/upload-file.js";

// レジストリをエクスポート
export { toolRegistry } from "./registry.js";
