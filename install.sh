#!/bin/bash
# Discord Two-Way MCP インストールスクリプト
# tmuxラッパーコマンド (tclaude, tcodex) を ~/.local/bin にインストール

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${HOME}/.local/bin"

echo "Discord Two-Way MCP インストーラー"
echo "=================================="
echo ""

# インストールディレクトリを作成
mkdir -p "$INSTALL_DIR"

# スクリプトをコピー
cp "$SCRIPT_DIR/scripts/tclaude" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/scripts/tcodex" "$INSTALL_DIR/"

# 実行権限を付与
chmod +x "$INSTALL_DIR/tclaude"
chmod +x "$INSTALL_DIR/tcodex"

echo "✅ インストール完了"
echo ""
echo "インストールされたコマンド:"
echo "  - tclaude  : Claude Code を tmux 内で起動"
echo "  - tcodex   : OpenAI Codex を tmux 内で起動"
echo ""

# PATHチェック
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
  echo "⚠️  警告: $INSTALL_DIR が PATH に含まれていません"
  echo "   以下を ~/.bashrc または ~/.zshrc に追加してください:"
  echo ""
  echo "   export PATH=\"\$HOME/.local/bin:\$PATH\""
  echo ""
fi
