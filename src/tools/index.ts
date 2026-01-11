// ツールを登録するためのエントリポイント
// 各ツールファイルをインポートするだけで自動登録される

import "./get-channel-messages.js";
import "./send-message.js";
import "./import-guild-messages.js";
import "./reply-to-message.js";
import "./get-channels-list.js";
import "./add-reaction.js";
import "./search-messages.js";

// レジストリをエクスポート
export { toolRegistry } from "./registry.js";
