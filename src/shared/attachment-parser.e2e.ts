/**
 * 添付ファイル解析のE2Eテスト
 * 実際のGemini APIを使用して画像と音声を解析
 */
import { isParsingEnabled, parseAttachment } from "./attachment-parser.js";

// テスト用の公開サンプルURL
const TEST_FILES = {
  // Google公式のテスト画像
  image: {
    url: "https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png",
    contentType: "image/png",
    filename: "google_logo.png",
  },
  // 公開されている短い音声サンプル
  audio: {
    url: "https://upload.wikimedia.org/wikipedia/commons/c/c8/Example.ogg",
    contentType: "audio/ogg",
    filename: "example.ogg",
  },
};

async function runTest(
  name: string,
  file: { url: string; contentType: string; filename: string },
) {
  console.log(`\n--- Testing ${name} ---`);
  console.log(`URL: ${file.url}`);
  console.log(`Content-Type: ${file.contentType}`);

  const startTime = Date.now();
  const result = await parseAttachment(
    file.url,
    file.contentType,
    file.filename,
  );
  const elapsed = Date.now() - startTime;

  if (result.parsed) {
    console.log(`✅ Success (${elapsed}ms)`);
    console.log(`Content: ${result.content}`);
  } else if (result.error) {
    console.log(`❌ Error (${elapsed}ms): ${result.error}`);
  } else {
    console.log(`⏭️ Skipped (parsing not available or unsupported type)`);
  }

  return result;
}

async function main() {
  console.log("=== Attachment Parser E2E Test ===\n");

  if (!isParsingEnabled()) {
    console.log("⚠️ GEMINI_API_KEY is not set. Parsing is disabled.");
    console.log("Set the environment variable to run the E2E test:");
    console.log(
      "  GEMINI_API_KEY=your_key bun run src/shared/attachment-parser.e2e.ts",
    );
    process.exit(0);
  }

  console.log("✅ Gemini API is enabled");

  let passed = 0;
  let failed = 0;

  // 画像テスト
  const imageResult = await runTest("Image (PNG)", TEST_FILES.image);
  if (imageResult.parsed) passed++;
  else failed++;

  // 音声テスト
  const audioResult = await runTest("Audio (OGG)", TEST_FILES.audio);
  if (audioResult.parsed) passed++;
  else failed++;

  console.log("\n=== Summary ===");
  console.log(`Passed: ${passed}, Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Test failed with error:", error);
  process.exit(1);
});
