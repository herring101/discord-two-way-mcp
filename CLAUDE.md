# Discord Two-Way MCP - 開発ガイド

Discord双方向通信MCPサーバー。ランタイムはBun、DBはSQLite + Prisma。

## ディレクトリ構造

```
src/
├── discord/     # Discordクライアント、スラッシュコマンド
├── lifecycle/   # エージェントライフサイクル管理（Reducerパターン）
├── mcp/         # MCPツール定義（tools/definitions/に各ツール）
├── db/          # Prismaクライアント、スキーマ
├── scheduler/   # 汎用スケジューラー（once, interval, cron, exponential）
└── shared/      # logger, format, tmux, attachment-parser
```

## 開発コマンド

```bash
bun run dev      # 開発実行
bun run lint     # リントチェック
bun run format   # フォーマット
bun test         # テスト実行

# DBマイグレーション
bunx prisma db push --schema="src/db/prisma/schema.prisma"
```

## 開発時の注意事項

### tmux send-keys問題
tmuxの`send-keys`コマンドで`---`を含むメッセージを送ると、`--`がオプションフラグとして誤認識される。
区切り文字には`===`を使用すること。

```typescript
// NG: tmuxでエラーになる
`--- 2026年1月11日 ---`

// OK
`=== 2026年1月11日 ===`
```

### ライフサイクル設計（Reducerパターン）
- `lifecycle/reducer.ts` - 純粋関数。状態遷移のみ担当
- `lifecycle/controller.ts` - 副作用処理（DB操作、スケジューラー）

状態遷移: `OFF` ⟷ `AWAKE_NOT_WATCHING` ⟷ `AWAKE_WATCHING`

### モジュールインポート
ESMのため`.js`拡張子必須:
```typescript
import { foo } from "./bar.js";  // OK
import { foo } from "./bar";     // NG
```

### DB初期化
Bot IDごとにDBファイルが作成される: `data/db/bot_{id}.sqlite`

### ログ出力
ログはプロジェクトの `data/logs/` に出力される:
- `app.log` - 全ログ（INFO以上）
- `error.log` - エラーログのみ

実際に稼働しているBotは `/home/herring/mcp/experiments/discord-two-way-mcp/` で動作しているため、デバッグ時は以下を確認すること:
- `/home/herring/mcp/experiments/discord-two-way-mcp/data/logs/app.log`
- `/home/herring/mcp/experiments/discord-two-way-mcp/data/logs/error.log`

### 除外対象
`src/db/generated/`はPrisma生成コード。biome/lintの対象外。

## MCPツール追加方法

1. `src/mcp/tools/definitions/`に新ファイル作成
2. `toolRegistry.register()`でツール登録
3. `src/mcp/tools/definitions/index.ts`でインポート

## 環境変数

| 変数名 | 必須 | 説明 |
|--------|------|------|
| `DISCORD_BOT_TOKEN` | ✓ | Discordボットトークン |
| `GEMINI_API_KEY` | - | 添付ファイル解析用（オプション） |
