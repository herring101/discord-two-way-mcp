/**
 * メモリリンク検証ツール
 * AGENTS.md / CLAUDE.md と docs/ 内の .md ファイルのリンク整合性を検証する
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Client } from "discord.js";
import { getLifecycleController } from "../../../discord/client.js";
import { defineTool, textResult } from "../registry.js";

let compactTimer: ReturnType<typeof setTimeout> | null = null;

function findMdFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findMdFiles(fullPath));
      } else if (entry.name.endsWith(".md")) {
        results.push(fullPath);
      }
    }
  } catch {
    // ディレクトリが存在しない場合は空配列
  }
  return results;
}

interface LinkInfo {
  file: string;
  line: number;
  target: string;
  resolvedPath: string;
}

function extractLinks(content: string, filePath: string): LinkInfo[] {
  const links: LinkInfo[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
    for (const match of line.matchAll(linkRegex)) {
      const target = match[2] ?? "";
      if (target.startsWith("http://") || target.startsWith("https://"))
        continue;
      if (!target.endsWith(".md")) continue;
      const resolvedPath = resolve(dirname(filePath), target);
      links.push({ file: filePath, line: i + 1, target, resolvedPath });
    }
  }
  return links;
}

defineTool(
  {
    name: "verify_memory_links",
    description:
      "AGENTS.md / CLAUDE.md と docs/ 以下の .md ファイルのリンク整合性を検証します。CLAUDE.md が @AGENTS.md wrapper になっていること、リンク切れ、孤立ドキュメントを検出します。成功時は60秒後に /compact を実行します。",
    inputSchema: {
      type: "object",
      properties: {
        cancel_compact: {
          type: "boolean",
          description: "true の場合、予約中の /compact をキャンセルします",
        },
      },
    },
  },
  async (_client: Client, args: Record<string, unknown>) => {
    // cancel_compact の処理
    if (args.cancel_compact === true) {
      if (compactTimer) {
        clearTimeout(compactTimer);
        compactTimer = null;
        return textResult("/compact の予約をキャンセルしました。");
      }
      return textResult("/compact の予約はありません。");
    }

    const baseDir = process.cwd();
    const agentsMdPath = join(baseDir, "AGENTS.md");
    const claudeMdPath = join(baseDir, "CLAUDE.md");
    const docsDir = join(baseDir, "docs");

    // AGENTS.md / CLAUDE.md の存在確認
    if (!existsSync(agentsMdPath)) {
      return textResult("メモリリンク検証失敗\nAGENTS.md が見つかりません。");
    }
    if (!existsSync(claudeMdPath)) {
      return textResult("メモリリンク検証失敗\nCLAUDE.md が見つかりません。");
    }

    const claudeContent = readFileSync(claudeMdPath, "utf-8");
    const firstMeaningfulLine =
      claudeContent
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0) ?? "";
    if (firstMeaningfulLine !== "@AGENTS.md") {
      return textResult(
        "メモリリンク検証失敗\nCLAUDE.md の最初の非空行が @AGENTS.md ではありません。",
      );
    }

    // 検証対象ファイルの収集
    const filesToCheck: string[] = [agentsMdPath, claudeMdPath];
    const docsFiles = findMdFiles(docsDir);
    filesToCheck.push(...docsFiles);

    // 全リンクの抽出
    const allLinks: LinkInfo[] = [];
    for (const filePath of filesToCheck) {
      try {
        const content = readFileSync(filePath, "utf-8");
        allLinks.push(...extractLinks(content, filePath));
      } catch {
        // 読み取れないファイルはスキップ
      }
    }

    // リンク切れの検出
    const brokenLinks = allLinks.filter(
      (link) => !existsSync(link.resolvedPath),
    );

    // 孤立ドキュメントの検出（docs/daily/ は除外）
    const linkedPaths = new Set(allLinks.map((l) => l.resolvedPath));
    const dailyDir = join(docsDir, "daily");
    const orphanDocs = docsFiles.filter((f) => {
      if (f.startsWith(`${dailyDir}/`) || f === dailyDir) return false;
      return !linkedPaths.has(f);
    });

    // 結果の生成
    if (brokenLinks.length === 0 && orphanDocs.length === 0) {
      // 成功
      const controller = getLifecycleController();

      // 既存の /compact 予約をキャンセル
      if (compactTimer) {
        clearTimeout(compactTimer);
      }

      compactTimer = setTimeout(() => {
        if (controller) {
          controller.sendToAgent("/compact");
        }
        compactTimer = null;
      }, 60000);

      return textResult(
        `メモリリンク検証完了（${filesToCheck.length}件のドキュメント、${allLinks.length}件のリンク、問題なし）\n` +
          `60秒後に /compact を実行します。キャンセルする場合は verify_memory_links({ cancel_compact: true }) を実行してください。`,
      );
    }

    // 失敗
    const resultLines: string[] = ["メモリリンク検証失敗"];

    if (orphanDocs.length > 0) {
      resultLines.push("孤立ドキュメント（どこからもリンクされていません）:");
      for (const f of orphanDocs) {
        resultLines.push(`  - ${relative(baseDir, f)}`);
      }
    }

    if (brokenLinks.length > 0) {
      resultLines.push("リンク切れ:");
      for (const link of brokenLinks) {
        const relFile = relative(baseDir, link.file);
        resultLines.push(
          `  - ${relFile}:${link.line}行目 → ${link.target}（ファイルが存在しません）`,
        );
      }
    }

    resultLines.push("修正後に verify_memory_links を再実行してください。");

    return textResult(resultLines.join("\n"));
  },
  { requiresDiscord: false },
);
