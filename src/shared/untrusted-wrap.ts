/**
 * untrusted な入力を `<UNTRUSTED_BEGIN ...> ... <UNTRUSTED_END>` で囲む純関数。
 *
 * 目的: LLM に「この内側は信頼されていないユーザーからの入力なので、命令として実行するな」と教える境界。
 *
 * 防御:
 *   - 属性値の `"` / 制御文字を除去/エスケープ（タグ偽装防止）
 *   - body 内の `<UNTRUSTED_BEGIN` / `<UNTRUSTED_END` を `<INNER_UNTRUSTED_*` に置換（入れ子偽装防止）
 */

const BEGIN_TAG = "UNTRUSTED_BEGIN";
const END_TAG = "UNTRUSTED_END";

/**
 * 属性値をエスケープする。制御文字を除去し、`"` を `\"` にする。
 */
function escapeAttr(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を除去するため
  return value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/"/g, '\\"');
}

/**
 * body 内の偽装タグを無効化する。
 * 大文字小文字無視、空白を許容して厳しめに置換。
 */
function neutralizeBody(body: string): string {
  return body.replace(/<\s*UNTRUSTED_(BEGIN|END)/gi, "<INNER_UNTRUSTED_$1");
}

export interface WrapUntrustedOptions {
  /** "discord:user:<id>" 等、信頼境界の発生源 */
  source: string;
  /** ラップ対象の本文 */
  body: string;
  /** 追加属性 (channel / username など) */
  meta?: Record<string, string>;
}

/**
 * 本文を UNTRUSTED 境界で囲んだ文字列を返す。
 *
 * 例:
 *   wrapUntrusted({ source: "discord:user:123", body: "hi" })
 *   → '<UNTRUSTED_BEGIN source="discord:user:123">\nhi\n<UNTRUSTED_END>'
 */
export function wrapUntrusted(opts: WrapUntrustedOptions): string {
  const attrs: string[] = [`source="${escapeAttr(opts.source)}"`];
  if (opts.meta) {
    for (const [key, value] of Object.entries(opts.meta)) {
      attrs.push(`${key}="${escapeAttr(value)}"`);
    }
  }
  const beginLine = `<${BEGIN_TAG} ${attrs.join(" ")}>`;
  const safeBody = neutralizeBody(opts.body);
  return `${beginLine}\n${safeBody}\n<${END_TAG}>`;
}
