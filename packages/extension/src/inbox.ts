import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CCCCBridgeClient } from "./client.ts";
import type { CCCSEvent } from "./types.ts";

export interface InboxPollerOptions {
  client: CCCCBridgeClient;
  groupId: string;
  actorId: string;
  pollIntervalMs: number;
  pi: ExtensionAPI;
  /** Shared deduplication set (e.g. from InboxStreamer) for fallback continuity. */
  seenIds?: Set<string>;
}

/**
 * Format a CCCC event into a human-readable message string.
 *
 * Produces: "New CCCC message from <by>:\n\n<text>"
 * Falls back to "(no text)" when event.data.text is missing.
 */
export function formatMessage(event: CCCSEvent): string {
  const by = event.by ?? "unknown";
  const raw = event.data?.text;
  const text = typeof raw === "string" ? raw : "(no text)";
  return `New CCCC message from ${by}:\n\n${text}`;
}

/**
 * Polls the CCCC daemon inbox on an interval and delivers new messages
 * into the Pi agent session via {@link ExtensionAPI.sendMessage}.
 *
 * Messages are deduplicated by event ID. Delivered messages are marked
 * read via the client. Errors are logged and never thrown — polling
 * continues across failures.
 */
export class InboxPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private seenIds: Set<string>;
  private options: InboxPollerOptions;

  constructor(options: InboxPollerOptions) {
    this.seenIds = options.seenIds ?? new Set<string>();
    this.options = options;
  }

  /** Start polling on the configured interval. */
  start(): void {
    if (this.timer !== null) return;
    // Fire immediately, then on the interval
    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, this.options.pollIntervalMs);
  }

  /** Stop polling and reset deduplication state. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.seenIds.clear();
  }

  /**
   * Execute one poll cycle: fetch inbox messages, deliver unseen ones,
   * and mark them as read.
   *
   * All errors are caught and logged — this method never throws.
   */
  async poll(): Promise<void> {
    try {
      const events = await this.options.client.inboxList({
        groupId: this.options.groupId,
        actorId: this.options.actorId,
      });

      for (const event of events) {
        if (this.seenIds.has(event.id)) continue;

        try {
          const raw = event.data?.text;
          const text = typeof raw === "string" ? raw : "(no text)";
          this.options.pi.sendMessage(
            {
              customType: "cccc-inbox",
              content: formatMessage(event),
              display: true,
              details: {
                groupId: this.options.groupId,
                eventId: event.id,
                by: event.by,
                text,
              },
            },
            { triggerTurn: true },
          );
        } catch (deliveryErr) {
          console.error(`[cccc-bridge] Failed to deliver message ${event.id}:`, deliveryErr);
          // Skip mark-read on delivery failure so it can be retried
          continue;
        }

        this.seenIds.add(event.id);

        try {
          await this.options.client.inboxMarkRead({
            groupId: this.options.groupId,
            actorId: this.options.actorId,
            eventId: event.id,
          });
        } catch (markErr) {
          console.error(`[cccc-bridge] Failed to mark message ${event.id} as read:`, markErr);
          // Non-fatal — continue polling
        }
      }
    } catch (pollErr) {
      console.error("[cccc-bridge] Inbox poll failed:", pollErr);
    }
  }
}
