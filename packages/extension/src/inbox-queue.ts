/**
 * Inbox message queue with debounce, idle gating, and batching.
 *
 * Mirrors pi-link's idle-gated inbox pattern:
 * 1. Debounce — coalesce burst arrivals (200ms window)
 * 2. Idle gate — check ctx.isIdle() before delivery; retry every 500ms
 * 3. Batch — up to 20 messages or ~16K chars per delivery
 * 4. Flush — on agent_end, scheduleFlush(0) triggers immediate flush attempt
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---- Constants ----

export const FLUSH_DELAY_MS = 200;
export const IDLE_RETRY_MS = 500;
export const BATCH_MAX_ITEMS = 20;
export const BATCH_MAX_CHARS = 16_000;

// ---- Types ----

export interface QueuedMessage {
  /** Pre-formatted display text (formatMessage output for single delivery) */
  content: string;
  /** Per-item details preserved in batch metadata */
  details: Record<string, unknown>;
  /** Called after the item is successfully delivered in a batch */
  onDelivered?: () => void;
}

export interface InboxQueueOptions {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
}

// ---- InboxQueue ----

export class InboxQueue {
  private readonly pi: ExtensionAPI;
  private readonly ctx: ExtensionContext;
  private readonly items: QueuedMessage[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(options: InboxQueueOptions) {
    this.pi = options.pi;
    this.ctx = options.ctx;
  }

  /**
   * Enqueue a message for batched delivery.
   * Resets the debounce timer on each call.
   */
  enqueue(msg: QueuedMessage): void {
    if (this.destroyed) return;
    this.items.push(msg);
    this.scheduleFlush(FLUSH_DELAY_MS);
  }

  /**
   * Wake up the flush pipeline — schedules an immediate flush attempt.
   * Intended to be called on `agent_end`.
   */
  wake(): void {
    if (this.destroyed) return;
    this.scheduleFlush(0);
  }

  /**
   * Destroy the queue — cancels any pending flush and prevents further delivery.
   */
  destroy(): void {
    this.destroyed = true;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.items.length = 0;
  }

  // ---- Internal ----

  private scheduleFlush(delay: number): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushInbox();
    }, delay);
  }

  private flushInbox(): void {
    if (this.destroyed || this.items.length === 0) return;

    // Idle gate: check if agent is idle before delivering
    let idle: boolean;
    try {
      idle = this.ctx.isIdle();
    } catch {
      // Stale context — bail without retry
      return;
    }
    if (!idle) {
      this.scheduleFlush(IDLE_RETRY_MS);
      return;
    }

    // Select batch: up to BATCH_MAX_ITEMS, ~BATCH_MAX_CHARS total (soft cap)
    const batch: QueuedMessage[] = [];
    let totalChars = 0;
    for (let i = 0; i < this.items.length && batch.length < BATCH_MAX_ITEMS; i++) {
      const item = this.items[i];
      if (batch.length > 0 && totalChars + item.content.length > BATCH_MAX_CHARS) {
        break;
      }
      batch.push(item);
      totalChars += item.content.length;
    }

    // Build delivery content
    let content: string;
    let details: Record<string, unknown>;

    if (batch.length === 1) {
      content = batch[0].content;
      details = { ...batch[0].details };
    } else {
      const numbered = batch.map((i, idx) => `${idx + 1}. ${i.content}`).join("\n\n");
      content = `[CCCC: ${batch.length} messages received]\n\n${numbered}`;
      details = {
        batched: true,
        count: batch.length,
        messages: batch.map((i) => i.details),
      };
    }

    // Deliver
    try {
      this.pi.sendMessage(
        {
          customType: "cccc-inbox",
          content,
          display: true,
          details,
        },
        { triggerTurn: true },
      );
    } catch {
      // Delivery failed — items remain in queue for retry on next poll/agent_end
      return;
    }

    // Fire onDelivered for each item in the batch
    for (const item of batch) {
      item.onDelivered?.();
    }

    // Remove delivered items from the queue
    this.items.splice(0, batch.length);

    // Reschedule if inbox still has items
    if (this.items.length > 0) {
      this.scheduleFlush(IDLE_RETRY_MS);
    }
  }
}
