import type {
  ActorAddOptions,
  ActorAddResult,
  InboxListOptions,
  InboxListResult,
  CCCSEvent,
  EventsStreamOptions,
  EventStreamItem,
  GroupsResult,
  GroupShowResult,
  SendCrossGroupOptions,
  SendResult,
} from "cccc-sdk";

/**
 * Config for connecting to a CCCC daemon.
 * Host/port defaults come from CCCC_DAEMON_HOST / CCCC_DAEMON_PORT env vars.
 */
export interface BridgeClientConfig {
  /** Daemon host (default from CCCC_DAEMON_HOST env, fallback 192.168.7.163) */
  host: string;
  /** Daemon port (default from CCCC_DAEMON_PORT env, fallback 9765) */
  port: number;
  /** Connection timeout in ms (default 30000) */
  timeoutMs: number;
}

/**
 * Lightweight interface matching the subset of CCCCClient methods we use.
 * Allows dependency injection for testing — CCCCClient satisfies this structurally.
 */
export interface CCCCClientLike {
  actorAdd(options: ActorAddOptions): Promise<ActorAddResult>;
  inboxList(options: InboxListOptions): Promise<InboxListResult>;
  inboxMarkRead(
    groupId: string,
    actorId: string,
    eventId: string,
    by?: string,
  ): Promise<Record<string, unknown>>;
  eventsStream(options: EventsStreamOptions): AsyncGenerator<EventStreamItem>;
  groups(): Promise<GroupsResult>;
  sendCrossGroup(options: SendCrossGroupOptions): Promise<SendResult>;
  groupShow(groupId: string): Promise<GroupShowResult>;
}

export type { CCCSEvent, GroupsResult, GroupShowResult, SendCrossGroupOptions, SendResult };

/**
 * Typed error thrown by CCCCBridgeClient when an SDK operation fails.
 * Wraps the original error in `cause` for debugging.
 */
export class BridgeClientError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "BridgeClientError";
    if (cause instanceof Error) {
      this.cause = cause;
    }
  }
}

/** Build a BridgeClientConfig from environment variables with sensible defaults. */
export function defaultBridgeConfig(): BridgeClientConfig {
  return {
    host: process.env.CCCC_DAEMON_HOST ?? "192.168.7.163",
    port: Number.parseInt(process.env.CCCC_DAEMON_PORT ?? "9765", 10),
    timeoutMs: 30_000,
  };
}
export type { EventsStreamOptions, EventStreamItem };
