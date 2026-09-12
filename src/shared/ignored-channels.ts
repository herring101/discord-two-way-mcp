export interface ChannelScoped {
  channelId: string;
}

export function parseIgnoredChannelIds(raw: string | undefined): Set<string> {
  if (!raw?.trim()) {
    return new Set();
  }

  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(
      parsed.filter((value): value is string => typeof value === "string"),
    );
  }

  return new Set(
    trimmed
      .split(",")
      .map((channelId) => channelId.trim())
      .filter(Boolean),
  );
}

export function filterIgnoredChannels<T extends ChannelScoped>(
  items: T[],
  ignoredChannelIds: ReadonlySet<string> | undefined,
): T[] {
  if (!ignoredChannelIds || ignoredChannelIds.size === 0) {
    return items;
  }

  return items.filter((item) => !ignoredChannelIds.has(item.channelId));
}
