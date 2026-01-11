# Discord Two-Way MCP

Discordメッセージをリアルタイムでターミナルに通知し、AIコーディングアシスタント（Claude Code、OpenAI Codexなど）と連携して双方向コミュニケーションを実現するMCPサーバーです。

本プロジェクトは **Ubuntu (WSL2)** 環境で動作確認済みです。

## 特徴

- **双方向通信**: Discordのメッセージ受信・送信・返信・リアクションが可能
- **ライフサイクル管理**:
  - `OFF` (睡眠): 時間帯による自動スリープ
  - `AWAKE_NOT_WATCHING` (待機): 起床中だが監視していない状態
  - `AWAKE_WATCHING` (監視): 特定のチャンネルをアクティブに監視
  - メッセージ通知のスマートフィルタリング
- **永続化**: SQLite + Prismaによるメッセージ履歴の保存と全文検索
- **Tmux連携**: 受信メッセージをtmuxのステータスラインやペインに通知

## 必要要件

- **OS**: Linux (Ubuntu 24.04+ on WSL2 推奨)
- **Runtime**: [Bun](https://bun.sh/) (v1.1以上)
- **Database**: SQLite
- **Tools**: tmux (通知機能利用時)

## インストール

1. **Bunのインストール** (未インストールの場合)
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

2. **リポジトリのクローン**
   ```bash
   git clone https://github.com/herring101/discord-two-way-mcp
   cd discord-two-way-mcp
   ```

3. **依存関係のインストール**
   ```bash
   bun install
   ```

4. **環境変数の設定**
   MCP設定ファイルに直接記述します。
   ```bash
   DISCORD_BOT_TOKEN="your_discord_bot_token"
   ```

## セットアップ

初回起動前にデータベースのマイグレーションが必要です。Bot IDごとに個別のDBファイル (`data/db/bot_{id}.sqlite`) が作成されます。

```bash
# マイグレーション実行
bunx prisma db push --schema="src/db/prisma/schema.prisma"
```

## MCP設定

AIアシスタントの設定ファイルにサーバーを追加します。

### Claude Code (`~/.config/claude/mcp.json`)

```json
{
  "mcpServers": {
    "discord": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/discord-two-way-mcp/src/index.ts"],
      "env": {
        "DISCORD_BOT_TOKEN": "your_bot_token",
        "LANG": "ja_JP.UTF-8"
      }
    }
  }
}
```

## 利用方法

MCPサーバー経由でBotが起動すると、以下の機能が利用可能になります。

### Discord スラッシュコマンド

- `/status`: Botの現在の状態（モード、監視チャンネル）を表示
- `/unread`: 未読メッセージのサマリーを表示
- `/config`: 現在のライフサイクル設定を表示

### 利用可能なMCPツール

| ツール名 | 説明 |
|----------|------|
| `get_channels_list` | チャンネル一覧を取得 |
| `get_channel_messages` | 指定チャンネルのメッセージを取得（既読化） |
| `get_unread_summary` | 未読メッセージのサマリーを取得 |
| `send_message` | メッセージを送信 |
| `reply_to_message` | メッセージに返信 |
| `add_reaction` | リアクションを追加 |
| `search_messages` | 保存済みメッセージを検索 |
| `end_activity` | 監視モードを終了して待機状態に戻る |
| `import_guild_messages` | 過去のメッセージをDBにインポート |

## 開発

```bash
# 開発サーバー起動
bun run dev

# リント
bun run lint

# フォーマット
bun run format

# テスト実行
bun test
```

## ディレクトリ構造

```
src/
├── discord/        # Discord Client, Slash Commands
├── lifecycle/      # Agent Lifecycle Management (Reducer, Config)
├── mcp/            # MCP Tools Definitions
├── db/             # Database (Prisma)
└── shared/         # Shared Utilities
```
