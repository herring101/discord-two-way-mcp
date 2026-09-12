import type { UnreadSummaryWithDetails } from "../lifecycle/index.js";
import {
  filterIgnoredChannels,
  parseIgnoredChannelIds,
} from "../shared/ignored-channels.js";

export { parseIgnoredChannelIds };

export function filterIgnoredActivityChannels(
  summary: UnreadSummaryWithDetails[],
  ignoredChannelIds: ReadonlySet<string>,
): UnreadSummaryWithDetails[] {
  return filterIgnoredChannels(summary, ignoredChannelIds);
}
