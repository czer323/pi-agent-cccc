import type { CCCCBridgeClient } from "./client.ts";
import type { CCCSEvent } from "./types.ts";
import type { InboxQueue } from "./inbox-queue.ts";
export interface InboxPollerOptions {
  client: CCCCBridgeClient;
  groupId: string;
  actorId: string;
  pollIntervalMs: number;
  queue: InboxQueue;
  /** Shared deduplication set (e.g. from InboxStreamer) for fallback continuity. */
  seenIds?: Set<string>;
  /** Callback fired when connection to daemon is restored after errors. */
  onReconnect?: () => void;
}

/**
 * Format a CCCC event into a human-readable message string with provenance metadata.
 *
 * Produces a header block with sender, group, timestamp, and optional flags
 * (cross-group, reply-required, attention priority), followed by the message text.
 */
export function formatMessage(event: CCCSEvent): string {
  const by = event.by ?? "unknown";
  const raw = event.data?.text;
  const text = typeof raw === "string" ? raw : "(no text)";
  const groupId = event.group_id ?? "?";
  const ts = event.ts ?? "?";

  const headerLines: string[] = [];
  headerLines.push(`**From:** ${by}`);
  headerLines.push(`**Group:** ${groupId}`);
  headerLines.push(`**Received:** ${ts}`);

  if (event.kind === "chat.cross_group_receipt") {
    const srcGroupId = event.data?.src_group_id as string | undefined;
    if (srcGroupId) {
      headerLines.push(`Cross-group message from ${srcGroupId}`);
    }
  }

  if (event.data?.reply_required === true) {
    headerLines.push("**Reply required**");
  }

  if (event.data?.priority === "attention") {
    headerLines.push("[ATTENTION]");
  }

  const header = headerLines.join("\n");

  // System messages (empty fallback text) get no reply instructions
  if (text === "(no text)") {
    return `---\n${header}\n\n${text}`;
  }

  return `---\n${header}\n\n${text}\n\n---\nReply via cccc_reply or cccc_send.`;
}

/**
 * Determine whether an event should be delivered to the given actor based on
 * the CCCC `to` field.
 *
 * Rules (checked in order; first match wins):
 * 1. Own lifecycle broadcasts → skip (by === actorId)
 * 2. No text content → skip (system event without message)
 * 3. `to` absent or empty → deliver (broadcast)
 * 4. `to` contains this actorId → deliver (direct message)
 * 5. `to` contains "@all" → deliver (broadcast)
 * 6. `to` contains "@peers" → deliver (this actor is a peer)
 * 7. `to` contains "@foreman" → skip (this actor is not foreman)
 * 8. `to` contains "@user" → skip (this is for the human user)
 * 9. Otherwise → skip (message is for another actor)
 */
export function shouldDeliver(event: CCCSEvent, actorId: string): boolean {
  // Filter own lifecycle broadcasts (Agent <id> online/offline)
  if (event.by === actorId) return false;
  // Filter system events with no text content
  if (!event.data?.text) return false;
  const to: string[] | undefined = event.data?.to as string[] | undefined;
  if (!to || to.length === 0) return true;
  if (to.includes(actorId)) return true;
  if (to.includes("@all")) return true;
  if (to.includes("@peers")) return true;
  if (to.includes("@foreman")) return false;
  if (to.includes("@user")) return false;
  return false;
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
  private lastErrorMsg: string | null = null;
  private consecutiveErrors = 0;

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
    this.lastErrorMsg = null;
    this.consecutiveErrors = 0;
  }

  /**
   * Execute one poll cycle: fetch inbox messages, deliver unseen ones,
   * and mark them as read.
   *
   * All errors are caught and logged — this method never throws.
   */
  async poll(): Promise<void> {
    // Backoff: skip poll if we've had consecutive errors
    if (this.consecutiveErrors >= 5) {
      // Only poll every 5th cycle when in backoff
      if (this.consecutiveErrors % 5 !== 0) return;
    }
    try {
      const events = await this.options.client.inboxList({
        groupId: this.options.groupId,
        actorId: this.options.actorId,
      });
      // Success — reset error state
      if (this.consecutiveErrors > 0) {
        this.options.onReconnect?.();
        this.consecutiveErrors = 0;
        this.lastErrorMsg = null;
      }
      for (const event of events) {
        if (this.seenIds.has(event.id)) continue;

        if (!shouldDeliver(event, this.options.actorId)) {
          // Not for this actor — skip without marking read
          this.seenIds.add(event.id);
          continue;
        }
        try {
          const raw = event.data?.text;
          const text = typeof raw === "string" ? raw : "(no text)";

          this.options.queue.enqueue({
            content: formatMessage(event),
            details: {
              actorId: this.options.actorId,
              groupId: this.options.groupId,
              eventId: event.id,
              by: event.by,
              text,
            },
            onDelivered: () => {
              // Mark as read on the server after successful delivery
              this.options.client
                .inboxMarkRead({
                  groupId: this.options.groupId,
                  actorId: this.options.actorId,
                  eventId: event.id,
                })
                .catch((markErr) => {
                  console.error(
                    `[cccc-bridge] Failed to mark message ${event.id} as read:`,
                    markErr,
                  );
                });
            },
          });
        } catch (enqueueErr) {
          console.error(`[cccc-bridge] Failed to enqueue message ${event.id}:`, enqueueErr);
          continue;
        }

        this.seenIds.add(event.id);
      }
    } catch (pollErr) {
      const msg = pollErr instanceof Error ? pollErr.message : String(pollErr);
      this.consecutiveErrors++;
      // Only log if the error message changed (dedup, like streamer)
      if (msg !== this.lastErrorMsg) {
        console.error(`[cccc-bridge] Inbox poll failed (${this.consecutiveErrors}x):`, msg);
        this.lastErrorMsg = msg;
      }
      // Backoff: skip next poll cycle(s) on repeated failures
      // After 5 consecutive errors, the interval effectively becomes 5x slower
      // but we don't change the timer — just skip the poll() call
    }
  }
}
