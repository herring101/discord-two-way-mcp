export {
  clearOwnerDmChannelId,
  getOwnerConfig,
  type OwnerConfig,
  setOwnerDmChannelId,
} from "./config.js";
export { MCP_SERVER_INSTRUCTIONS } from "./instructions.js";
export {
  buildNotificationEmbeds,
  EMBED_CHUNK_LIMIT,
  type NotificationEmbedSpec,
  parseSeverity,
  SEVERITIES,
  SEVERITY_COLOR,
  SEVERITY_LABEL,
  type Severity,
  splitMessage,
} from "./notify.js";
export {
  attachDmMessageId,
  createPendingTrustRequest,
  findPendingTrustRequest,
  isExpired,
  type PendingTrustRequest,
  resolvePendingTrustRequest,
} from "./pending-trust.js";
export {
  addTrustedUsers,
  isTrustedUser,
  listTrustedUsers,
  parseTrustedUserIdsFromEnv,
  removeTrustedUsers,
  resetTrustCache,
  setBotUserId,
  type TrustedUserEntry,
} from "./trust.js";
// untrusted-wrap は pure formatting なので shared/ に移動済 (HER-80)
// 後方互換のため security/ からも引き続き re-export
export {
  type WrapUntrustedOptions,
  wrapUntrusted,
} from "../shared/untrusted-wrap.js";
