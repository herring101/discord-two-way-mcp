/**
 * restart_discord_mcp の純粋ロジックテスト。
 */

import { describe, expect, test } from "bun:test";
import {
  resolveLaunchScriptPath,
  resolveRestartTarget,
  sessionNameToCharacterName,
} from "./restart-discord-mcp-core.js";

describe("sessionNameToCharacterName", () => {
  test("codex セッション名から character 名を取り出す", () => {
    expect(sessionNameToCharacterName("codex-clamane")).toBe("clamane");
  });

  test("claude セッション名から character 名を取り出す", () => {
    expect(sessionNameToCharacterName("claude-stella")).toBe("stella");
  });

  test("想定外のセッション名は undefined", () => {
    expect(sessionNameToCharacterName("restart-clamane-123")).toBeUndefined();
  });
});

describe("resolveLaunchScriptPath", () => {
  test("env 指定があれば優先する", () => {
    expect(
      resolveLaunchScriptPath({
        DISCORD_MCP_RESTART_LAUNCH_SH: "/tmp/launch.sh",
      }),
    ).toBe("/tmp/launch.sh");
  });

  test("env 指定がなければ agent-workspace の launch.sh", () => {
    expect(resolveLaunchScriptPath({})).toBe(
      "/home/herring/agent-workspace/launch.sh",
    );
  });
});

describe("resolveRestartTarget", () => {
  test("DISCORD_MCP_RESTART_SESSION を優先する", () => {
    const target = resolveRestartTarget({
      env: {
        DISCORD_MCP_RESTART_SESSION: "codex-polaire",
        TMUX_SESSION_FILE: "/tmp/session-file",
      },
      readFile: () => "codex-clamane",
      exists: () => true,
    });

    expect(target).toEqual({
      sessionName: "codex-polaire",
      characterName: "polaire",
      launchScriptPath: "/home/herring/agent-workspace/launch.sh",
    });
  });

  test("TMUX_SESSION_FILE から現在セッションを解決する", () => {
    const target = resolveRestartTarget({
      env: { TMUX_SESSION_FILE: "/tmp/session-file" },
      readFile: () => "codex-clamane\n",
      exists: () => true,
    });

    expect(target).toEqual({
      sessionName: "codex-clamane",
      characterName: "clamane",
      launchScriptPath: "/home/herring/agent-workspace/launch.sh",
    });
  });

  test("ancestor env の TMUX_SESSION_FILE から現在セッションを解決する", () => {
    const target = resolveRestartTarget({
      env: {},
      findEnv: (key) =>
        key === "TMUX_SESSION_FILE" ? "/tmp/session-file" : undefined,
      readFile: () => "codex-clamane\n",
      exists: () => true,
    });

    expect(target).toEqual({
      sessionName: "codex-clamane",
      characterName: "clamane",
      launchScriptPath: "/home/herring/agent-workspace/launch.sh",
    });
  });

  test("明示 sessionName があれば優先する", () => {
    const target = resolveRestartTarget({
      env: {},
      requestedSessionName: "codex-clamane",
      readFile: () => "",
      exists: () => false,
    });

    expect(target).toEqual({
      sessionName: "codex-clamane",
      characterName: "clamane",
      launchScriptPath: "/home/herring/agent-workspace/launch.sh",
    });
  });

  test("明示 characterName から codex session を組み立てる", () => {
    const target = resolveRestartTarget({
      env: {},
      requestedCharacterName: "clamane",
      readFile: () => "",
      exists: () => false,
    });

    expect(target).toEqual({
      sessionName: "codex-clamane",
      characterName: "clamane",
      launchScriptPath: "/home/herring/agent-workspace/launch.sh",
    });
  });

  test("セッションが解決できなければ error", () => {
    const target = resolveRestartTarget({
      env: {},
      readFile: () => "",
      exists: () => true,
    });

    expect(target).toEqual({
      error:
        "現在の bot セッションを特定できません。sessionName / characterName / TMUX_SESSION_FILE / DISCORD_MCP_RESTART_SESSION のいずれかを設定してください。",
    });
  });
});
