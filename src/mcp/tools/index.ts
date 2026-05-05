// ツールを登録するためのエントリポイント
// 各ツールファイルをインポートするだけで自動登録される

import "./definitions/add-reaction.js";
import "./definitions/clear-send-target.js";
import "./definitions/create-reminder.js";
import "./definitions/delete-reminder.js";
import "./definitions/end-activity.js";
import "./definitions/get-channel-messages.js";
import "./definitions/get-channels-list.js";
import "./definitions/get-unread-summary.js";
import "./definitions/import-guild-messages.js";
import "./definitions/list-reminders.js";
import "./definitions/manage-trust.js";
import "./definitions/notify-owner.js";
import "./definitions/search-messages.js";
import "./definitions/send-message.js";
import "./definitions/set-send-target.js";
import "./definitions/update-lifecycle-config.js";
import "./definitions/upload-file.js";
import "./definitions/verify-memory-links.js";

// レジストリをエクスポート
export { toolRegistry } from "./registry.js";
