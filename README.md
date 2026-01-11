# Discord Two-Way MCP

Discordメッセージをリアルタイムでターミナルに通知し、AIコーディングアシスタント（Claude Code、OpenAI Codex）と連携するMCPサーバー。

## 対応環境

| ツール | コマンド | 説明 |
|--------|----------|------|
| Claude Code | `tclaude` | Claude Codeをtmux内で起動 |
| OpenAI Codex | `tcodex` | Codexをtmux内で起動 |

## インストール

```bash
# リポジトリをクローン
git clone <repository-url>
cd discord-two-way-mcp

# 依存関係をインストール
bun install

# ラッパーコマンドをインストール（~/.local/bin）
./install.sh
```
## MCP設定

### Claude Code

`~/.config/claude/mcp.json` または `.mcp.json`

```json
{
  "mcpServers": {
    "discord": {
      "command": "bun",
      "args": ["run", "/path/to/discord-two-way-mcp/src/index.ts"],
      "env": {
        "DISCORD_BOT_TOKEN": "your_bot_token"
      }
    }
  }
}
```

### OpenAI Codex

`~/.codex/config.toml`

```toml
[mcp_servers.discord-two-way]
command = "bun"
args = [
  "run",
  "/path/to/discord-two-way-mcp/src/index.ts"
]

[mcp_servers.discord-two-way.env]
DISCORD_BOT_TOKEN = "YOUR_TOKEN_HERE"
```

## 起動

```bash
# プロジェクトディレクトリに移動
cd /path/to/your/project

# Claude Codeを起動（tmux内）
tclaude

# または Codex を起動
tcodex
```

Discordにメッセージが届くと、tmuxセッションに通知が表示されます。

## 利用可能なMCPツール

| ツール | 説明 |
|--------|------|
| `get_channels_list` | 全ギルドのチャンネル一覧 |
| `get_channel_messages` | チャンネルメッセージ取得 |
| `send_message` | メッセージ送信 |
| `reply_to_message` | メッセージ返信 |
| `add_reaction` | リアクション追加 |
| `search_messages` | DB内メッセージ検索 |
| `import_guild_messages` | ギルドメッセージをDBにインポート |
