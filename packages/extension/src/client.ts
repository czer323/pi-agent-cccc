import { CCCCClient } from "cccc-sdk";
import type {
  CCCCClientLike,
  BridgeClientConfig,
  CCCSEvent,
  EventsStreamOptions,
  EventStreamItem,
  GroupsResult,
  GroupShowResult,
  ReplyOptions,
  SendOptions,
  SendCrossGroupOptions,
  SendResult,
} from "./types.ts";
import { BridgeClientError, defaultBridgeConfig } from "./types.ts";
export type {
  CCCCClientLike,
  BridgeClientConfig,
  CCCSEvent,
  GroupsResult,
  GroupShowResult,
  ReplyOptions,
  SendOptions,
  SendCrossGroupOptions,
  SendResult,
};
export { BridgeClientError, defaultBridgeConfig };

/**
 * Wrapper around the CCCC SDK client providing a clean interface for the
 * bridge extension. Handles connection lifecycle, endpoint configuration,
 * and error wrapping.
 *
 * **Dependency injection for tests:**
 * Pass a `CCCCClientLike` stub to the constructor to avoid hitting the live
 * daemon. At runtime (no injected client), `connect()` creates a real
 * {@link CCCCClient} via the SDK.
 */
export class CCCCBridgeClient {
  private _client: CCCCClientLike | null;

  /**
   * @param client - Optional injected client (for testing). If omitted,
   *                 `connect()` will create one via the SDK.
   */
  constructor(client?: CCCCClientLike) {
    this._client = client ?? null;
  }

  /**
   * Connect to the CCCC daemon.
   * If a client was injected via the constructor, this is a no-op.
   * Otherwise creates a real CCCCClient configured for TCP to the given host/port.
   */
  async connect(config: BridgeClientConfig): Promise<void> {
    if (this._client) return;

    const endpoint = {
      transport: "tcp" as const,
      path: "",
      host: config.host,
      port: config.port,
    };
    try {
      this._client = await CCCCClient.create({
        endpoint,
        timeoutMs: config.timeoutMs,
      });
    } catch (err) {
      console.error("Failed to connect to CCCC daemon:", err);
      throw new BridgeClientError("Failed to connect to CCCC daemon", err);
    }
  }

  /** Disconnect and release the client reference. */
  disconnect(): void {
    this._client = null;
  }

  /**
   * Register an actor with the daemon.
   * Wraps the SDK's `actorAdd`, returning only the assigned actor ID.
   */
  async registerActor(params: {
    groupId: string;
    actorId: string;
    runtime?: string;
    runner?: string;
    title?: string;
  }): Promise<{ actorId: string }> {
    this._ensureConnected();
    try {
      const result = await this._client!.actorAdd({
        groupId: params.groupId,
        actorId: params.actorId,
        runtime: params.runtime,
        runner: params.runner,
        title: params.title,
      });
      return { actorId: result.actor_id };
    } catch (err) {
      console.error("registerActor failed:", err);
      throw new BridgeClientError("registerActor failed", err);
    }
  }

  /**
   * Remove an actor from a group.
   * Wraps the SDK's `actorRemove`, which takes positional args.
   */
  async actorRemove(groupId: string, actorId: string): Promise<void> {
    this._ensureConnected();
    try {
      await this._client!.actorRemove(groupId, actorId);
    } catch (err) {
      throw new BridgeClientError("actorRemove failed", err);
    }
  }

  /**
   * List inbox messages for an actor.
   * Returns just the messages array; the cursor is internal to the wrapper.
   */
  async inboxList(params: {
    groupId: string;
    actorId: string;
    limit?: number;
  }): Promise<CCCSEvent[]> {
    this._ensureConnected();
    try {
      const result = await this._client!.inboxList({
        groupId: params.groupId,
        actorId: params.actorId,
        limit: params.limit,
      });
      return result.messages;
    } catch (err) {
      console.error("inboxList failed:", err);
      throw new BridgeClientError("inboxList failed", err);
    }
  }

  /**
   * Mark an inbox message as read.
   * The SDK uses positional args; this wrapper exposes a params object for
   * consistency with the other methods.
   */
  async inboxMarkRead(params: {
    groupId: string;
    actorId: string;
    eventId: string;
  }): Promise<void> {
    this._ensureConnected();
    try {
      await this._client!.inboxMarkRead(params.groupId, params.actorId, params.eventId);
    } catch (err) {
      console.error("inboxMarkRead failed:", err);
      throw new BridgeClientError("inboxMarkRead failed", err);
    }
  }

  /**
   * Subscribe to the group event stream (long-lived connection).
   * Wraps the SDK's eventsStream which returns an async generator of
   * EventStreamItem (events, heartbeats, and unknown items).
   */
  eventsStream(options: EventsStreamOptions): AsyncGenerator<EventStreamItem> {
    this._ensureConnected();
    return this._client!.eventsStream(options);
  }
  /**
   * List all groups known to the daemon.
   */
  async groups(): Promise<GroupsResult> {
    this._ensureConnected();
    try {
      return await this._client!.groups();
    } catch (err) {
      console.error("groups failed:", err);
      throw new BridgeClientError("groups failed", err);
    }
  }

  /**
   * Show detailed group info including scopes.
   */
  async groupShow(groupId: string): Promise<GroupShowResult> {
    this._ensureConnected();
    try {
      return await this._client!.groupShow(groupId);
    } catch (err) {
      console.error("groupShow failed:", err);
      throw new BridgeClientError("groupShow failed", err);
    }
  }

  /**
   * Send a chat message within the current group.
   * Wraps the SDK's `send` which delivers a message to one or more recipients.
   */
  async send(options: SendOptions): Promise<SendResult> {
    this._ensureConnected();
    try {
      return await this._client!.send(options);
    } catch (err) {
      console.error("send failed:", err);
      throw new BridgeClientError("send failed", err);
    }
  }

  /**
   * Reply to a specific event within a group.
   * Wraps the SDK's `reply` which creates a reply linked to an original event.
   */
  async reply(options: ReplyOptions): Promise<SendResult> {
    this._ensureConnected();
    try {
      return await this._client!.reply(options);
    } catch (err) {
      console.error("reply failed:", err);
      throw new BridgeClientError("reply failed", err);
    }
  }

  /**
   * Send a message across groups via the Group Bridge.
   * Wraps the SDK's sendCrossGroup which creates a source message in the
   * origin group and a forwarded message in the destination group.
   */
  async sendCrossGroup(options: SendCrossGroupOptions): Promise<SendResult> {
    this._ensureConnected();
    try {
      return await this._client!.sendCrossGroup(options);
    } catch (err) {
      throw new BridgeClientError("sendCrossGroup failed", err);
    }
  }

  /** Guard: throw a typed error if no client is available. */
  private _ensureConnected(): void {
    if (!this._client) {
      throw new BridgeClientError("Not connected");
    }
  }
}
