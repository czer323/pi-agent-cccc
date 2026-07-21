/**
 * Persistent TCP event stream consumer for the CCCC bridge.
 *
 * Replaces inbox_list polling with a long-lived events_stream connection
 * using the cccc-sdk's {@link CCCCClient.eventsStream} async generator.
 * Handles reconnection with exponential backoff and falls back to the
 * polling-based {@link InboxPoller} after exhausting retries.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CCCCBridgeClient } from "./client.ts";
import type { EventStreamItem } from "./types.ts";
import type { EventStreamEvent } from "cccc-sdk";
import { formatMessage, shouldDeliver } from "./inbox.ts";
import type { InboxQueue } from "./inbox-queue.ts";
export interface InboxStreamerOptions {
  client: CCCCBridgeClient;
  groupId: string;
  actorId: string;
  queue: InboxQueue;
  onFallback: () => void;
  seenIds?: Set<string>;
}

const BACKOFF_DELAYS = [1_000, 2_000, 4_000, 8_000, 30_000];
const MAX_RETRIES = BACKOFF_DELAYS.length;

export class InboxStreamer {
  readonly seenIds: Set<string>;

  private _running = false;
  private _abortController: AbortController | null = null;
  private _options: InboxStreamerOptions;
  private _lastError: string | null = null;
  private _fallbackTriggered = false;

  constructor(options: InboxStreamerOptions) {
    this._options = options;
    this.seenIds = options.seenIds ?? new Set<string>();
  }

  get running(): boolean {
    return this._running;
  }

  start(): void {
    if (this._running) return;
    this._running = true;
    this._fallbackTriggered = false;
    this._abortController = new AbortController();
    this._run(0).catch((err) => console.error("[cccc-bridge] InboxStreamer fatal error:", err));
  }

  stop(): void {
    this._running = false;
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
  }

  private async _run(retryCount: number): Promise<void> {
    if (!this._running) return;

    const { client, groupId, actorId } = this._options;
    const abortSignal = this._abortController!.signal;

    try {
      const stream = client.eventsStream({
        groupId,
        by: actorId,
        kinds: ["chat.message", "chat.cross_group_receipt"],
        signal: abortSignal,
      });
      this._lastError = null;

      for await (const item of stream) {
        if (!this._running) break;
        this._handleItem(item);
      }
    } catch (err) {
      if (!this._running) return;
      if (abortSignal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== this._lastError) {
        console.error("[cccc-bridge] Event stream error:", msg);
        this._lastError = msg;
      }
    }

    if (!this._running) return;

    if (retryCount >= MAX_RETRIES) {
      this._triggerFallback();
      return;
    }

    const delay = BACKOFF_DELAYS[Math.min(retryCount, BACKOFF_DELAYS.length - 1)];
    await this._delay(delay, abortSignal);
    if (!this._running) return;

    void this._run(retryCount + 1);
  }

  private _handleItem(item: EventStreamItem): void {
    if (item.t !== "event") return;
    const event = (item as EventStreamEvent).event;

    if (this.seenIds.has(event.id)) return;

    if (!shouldDeliver(event, this._options.actorId)) {
      // Not for this actor — skip
      return;
    }

    const raw = event.data?.text;
    const text = typeof raw === "string" ? raw : "(no text)";

    // Extract cross-group provenance when present
    const data = event.data ?? {};
    const srcGroupId =
      (data.src_group_id as string | undefined) ??
      (event.kind === "chat.cross_group_receipt" ? this._options.groupId : undefined);
    const srcEventId =
      (data.src_event_id as string | undefined) ??
      (event.kind === "chat.cross_group_receipt"
        ? (data.source_event_id as string | undefined)
        : undefined);

    const details: Record<string, unknown> = {
      actorId: this._options.actorId,
      groupId: this._options.groupId,
      eventId: event.id,
      by: event.by,
      text,
    };
    if (srcGroupId) details.srcGroupId = srcGroupId;
    if (srcEventId) details.srcEventId = srcEventId;
    this._options.queue.enqueue({
      content: formatMessage(event),
      details,
    });

    this.seenIds.add(event.id);
}

  private _delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      timer.unref?.();
    });
  }

  private _triggerFallback(): void {
    if (this._fallbackTriggered) return;
    this._fallbackTriggered = true;
    console.warn("[cccc-bridge] Event stream max retries reached, falling back to polling");
    this._options.onFallback();
  }
}
