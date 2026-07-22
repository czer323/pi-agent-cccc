/**
 * Configuration for the CCCC bridge extension.
 * All values default from environment variables.
 */

export interface BridgeConfig {
  /** CCCC daemon host (CCCC_DAEMON_HOST, default "192.168.7.163") */
  daemonHost: string;
  /** CCCC daemon port (CCCC_DAEMON_PORT, default 9765) */
  daemonPort: number;
  /** CCCC group IDs array — empty means the extension is inert.
   *  Populated from CCCC_GROUP_IDS (comma-separated) or CCCC_GROUP_ID (single). */
  groups: string[];
  /** Explicit actor ID override (CCCC_ACTOR_ID) — null means auto-resolve */
  actorId: string | null;
  /** Polling interval in ms (CCCC_POLL_INTERVAL_MS, default 3000) */
  pollIntervalMs: number;
  /** Auto-discover groups from cwd/git repository scope (CCCC_AUTO_DISCOVER, default true).
   *  When true and groups array is empty, session_start calls discoverGroups() to find
   *  matching groups based on cwd / git repo root. */
  autoDiscover: boolean;
  /** Default group ID when auto-discovery finds no match (CCCC_DEFAULT_GROUP_ID).
   *  Only used when autoDiscover is true and groups array is empty. */
  defaultGroupId: string | null;
  /** Agent title displayed in CCCC Web UI (CCCC_AGENT_TITLE, default "Pi Agent") */
  agentTitle: string;
  /** Sub-agent title (CCCC_SUB_AGENT_TITLE, default "Pi Sub-Agent") */
  subAgentTitle: string;
}

/**
 * Read bridge configuration from environment variables.
 *
 * Returns a fully populated {@link BridgeConfig}. The caller is responsible
 * for checking whether {@link BridgeConfig.groups} is empty and staying
 * inert if so — this function never throws for missing values.
 *
 * When CCCC_GROUP_IDS is set (comma-separated), it takes precedence over
 * CCCC_GROUP_ID. Whitespace around group IDs is trimmed.
 */
export function loadConfig(): BridgeConfig {
  const groupIdsRaw = process.env.CCCC_GROUP_IDS ?? process.env.CCCC_GROUP_ID ?? "";
  const groups = groupIdsRaw
    .split(",")
    .map((g) => g.trim())
    .filter((g) => g.length > 0);

  return {
    daemonHost: process.env.CCCC_DAEMON_HOST ?? "192.168.7.163",
    daemonPort: Number.parseInt(process.env.CCCC_DAEMON_PORT ?? "9765", 10),
    groups,
    actorId: process.env.CCCC_ACTOR_ID ?? null,
    pollIntervalMs: Number.parseInt(process.env.CCCC_POLL_INTERVAL_MS ?? "3000", 10),
    autoDiscover: process.env.CCCC_AUTO_DISCOVER !== "false",
    agentTitle: process.env.CCCC_AGENT_TITLE ?? "Pi Agent",
    subAgentTitle: process.env.CCCC_SUB_AGENT_TITLE ?? "Pi Sub-Agent",
    defaultGroupId: process.env.CCCC_DEFAULT_GROUP_ID ?? null,
  };
}
