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
  findEnv?: (key: string) => string | undefined;
  requestedSessionName?: string;
  requestedCharacterName?: string;
}): RestartTargetResult {
  const {
    env,
    readFile,
    exists,
    findEnv,
    requestedCharacterName,
    requestedSessionName,
  } = options;
  const launchScriptPath = resolveLaunchScriptPath(env);

  let sessionName =
    requestedSessionName?.trim() ?? env.DISCORD_MCP_RESTART_SESSION?.trim();
  const characterName = requestedCharacterName?.trim();
  if (!sessionName && characterName) {
    sessionName = `codex-${characterName}`;
  }

  const sessionFile = env.TMUX_SESSION_FILE ?? findEnv?.("TMUX_SESSION_FILE");
  if (!sessionName && sessionFile && exists(sessionFile)) {
    sessionName = readFile(sessionFile).trim();
  }

  if (!sessionName) {
    return {
      error:
        "現在の bot セッションを特定できません。sessionName / characterName / TMUX_SESSION_FILE / DISCORD_MCP_RESTART_SESSION のいずれかを設定してください。",
    };
  }

  const resolvedCharacterName = sessionNameToCharacterName(sessionName);
  if (!resolvedCharacterName) {
    return {
      error: `セッション名 "${sessionName}" から bot 名を特定できません。codex-<name> または claude-<name> 形式が必要です。`,
    };
  }

  return {
    sessionName,
    characterName: resolvedCharacterName,
    launchScriptPath,
  };
}
