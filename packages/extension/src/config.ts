/**
 * Configuration for the CCCC bridge extension.
 * All values default from environment variables.
 */

export interface BridgeConfig {
  /** CCCC daemon host (CCCC_DAEMON_HOST, default "192.168.7.163") */
  daemonHost: string;
  /** CCCC daemon port (CCCC_DAEMON_PORT, default 9765) */
  daemonPort: number;
  /** CCCC group ID (CCCC_GROUP_ID) — empty string means the extension is inert */
  groupId: string;
  /** Explicit actor ID override (CCCC_ACTOR_ID) — null means auto-resolve */
  actorId: string | null;
  /** Polling interval in ms (CCCC_POLL_INTERVAL_MS, default 3000) */
  pollIntervalMs: number;
}

/**
 * Read bridge configuration from environment variables.
 *
 * Returns a fully populated {@link BridgeConfig}. The caller is responsible
 * for checking whether {@link BridgeConfig.groupId} is empty and staying
 * inert if so — this function never throws for missing values.
 */
export function loadConfig(): BridgeConfig {
  return {
    daemonHost: process.env.CCCC_DAEMON_HOST ?? "192.168.7.163",
    daemonPort: Number.parseInt(process.env.CCCC_DAEMON_PORT ?? "9765", 10),
    groupId: process.env.CCCC_GROUP_ID ?? "",
    actorId: process.env.CCCC_ACTOR_ID ?? null,
    pollIntervalMs: Number.parseInt(process.env.CCCC_POLL_INTERVAL_MS ?? "3000", 10),
  };
}
