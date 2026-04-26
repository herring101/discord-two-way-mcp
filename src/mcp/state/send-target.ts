import type { Client } from "discord.js";
import { fetchTextBasedChannel } from "../../discord/helpers.js";
import { getLogger } from "../../shared/logger.js";

const logger = getLogger("mcp/state/send-target");

const TYPING_REFRESH_INTERVAL_MS = 5_000;

export interface SendTarget {
  channelId: string;
  replyToMessageId?: string;
}

interface ActiveTarget extends SendTarget {
  refreshTimer: NodeJS.Timeout;
}

let activeTarget: ActiveTarget | null = null;

async function fireTyping(client: Client, channelId: string): Promise<void> {
  try {
    const channel = await fetchTextBasedChannel(client, channelId);
    await channel.sendTyping();
  } catch (error) {
    logger.warn(
      `[send-target] sendTyping failed for ${channelId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function setSendTarget(
  client: Client,
  target: SendTarget,
): Promise<void> {
  clearSendTarget();

  await fireTyping(client, target.channelId);

  const refreshTimer = setInterval(() => {
    void fireTyping(client, target.channelId);
  }, TYPING_REFRESH_INTERVAL_MS);

  activeTarget = { ...target, refreshTimer };
}

export function getSendTarget(): SendTarget | null {
  if (!activeTarget) {
    return null;
  }
  return {
    channelId: activeTarget.channelId,
    replyToMessageId: activeTarget.replyToMessageId,
  };
}

export function clearSendTarget(): void {
  if (!activeTarget) {
    return;
  }
  clearInterval(activeTarget.refreshTimer);
  activeTarget = null;
}
