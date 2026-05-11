/**
 * restart_discord_mcp の純粋ロジック。
 */

export interface RestartTarget {
  sessionName: string;
  characterName: string;
  launchScriptPath: string;
}

export type RestartTargetResult = RestartTarget | { error: string };

export function sessionNameToCharacterName(
  sessionName: string,
): string | undefined {
  const match = /^(?:codex|claude)-(.+)$/.exec(sessionName.trim());
  return match?.[1];
}

export function resolveLaunchScriptPath(
  env: Record<string, string | undefined>,
): string {
  return (
    env.DISCORD_MCP_RESTART_LAUNCH_SH ??
    "/home/herring/agent-workspace/launch.sh"
  );
}

export function resolveRestartTarget(options: {
  env: Record<string, string | undefined>;
  readFile: (path: string) => string;
  exists: (path: string) => boolean;
}): RestartTargetResult {
  const { env, readFile, exists } = options;
  const launchScriptPath = resolveLaunchScriptPath(env);

  let sessionName = env.DISCORD_MCP_RESTART_SESSION?.trim();
  if (!sessionName && env.TMUX_SESSION_FILE && exists(env.TMUX_SESSION_FILE)) {
    sessionName = readFile(env.TMUX_SESSION_FILE).trim();
  }

  if (!sessionName) {
    return {
      error:
        "現在の bot セッションを特定できません。TMUX_SESSION_FILE または DISCORD_MCP_RESTART_SESSION を設定してください。",
    };
  }

  const characterName = sessionNameToCharacterName(sessionName);
  if (!characterName) {
    return {
      error: `セッション名 "${sessionName}" から bot 名を特定できません。codex-<name> または claude-<name> 形式が必要です。`,
    };
  }

  return { sessionName, characterName, launchScriptPath };
}
