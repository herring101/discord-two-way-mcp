// ツールを登録するためのエントリポイント
// 各ツールファイルをインポートするだけで自動登録される

import "./definitions/add-reaction.js";
import "./definitions/get-channel-messages.js";
import "./definitions/get-channels-list.js";
import "./definitions/import-guild-messages.js";
import "./definitions/reply-to-message.js";
import "./definitions/search-messages.js";
import "./definitions/send-message.js";

// レジストリをエクスポート
export { toolRegistry } from "./registry.js";
