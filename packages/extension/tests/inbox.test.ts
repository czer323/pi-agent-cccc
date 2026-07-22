// oxlint-disable typescript/unbound-method
import { expect, test, vi, describe, beforeEach } from "vite-plus/test";
import { InboxPoller, formatMessage, shouldDeliver } from "../src/inbox.ts";
import type { InboxQueue } from "../src/inbox-queue.ts";
import type { CCCCBridgeClient } from "../src/client.ts";
import type { CCCSEvent } from "../src/types.ts";

// ---- helpers ----

const testGroupId = "test-group";
const testActorId = "test-actor";
const testPollInterval = 100;

function makeEvent(overrides: Partial<CCCSEvent> & { id: string }): CCCSEvent {
  return {
    id: overrides.id,
    kind: overrides.kind ?? "chat.message",
    group_id: overrides.group_id ?? "g_test",
    by: overrides.by ?? "unknown",
    data: overrides.data ?? { text: "(no text)" },
    ts: overrides.ts ?? "2026-07-21T00:00:00Z",
  };
}

function createMocks() {
  const client = {
    inboxList: vi.fn(),
    inboxMarkRead: vi.fn(),
    registerActor: vi.fn(),
  } as unknown as CCCCBridgeClient;

  const enqueue = vi.fn();
  const queue = { enqueue } as unknown as InboxQueue;

  return { client, queue, enqueue };
}

// ---- formatMessage ----

describe("formatMessage", () => {
  test("produces correct output with text", () => {
    const event = makeEvent({ id: "evt-1", by: "alice", data: { text: "Hello world" } });
    expect(formatMessage(event)).toBe(
      "---\n**From:** alice\n**Group:** g_test\n**Received:** 2026-07-21T00:00:00Z\n\nHello world\n\n---\nReply via cccc_reply or cccc_send.",
    );
  });

  test("handles missing text with fallback — no reply hint for system messages", () => {
    const event = makeEvent({ id: "evt-2", by: "bob", data: {} });
    expect(formatMessage(event)).toBe(
      "---\n**From:** bob\n**Group:** g_test\n**Received:** 2026-07-21T00:00:00Z\n\n(no text)",
    );
  });

  test("handles null text with fallback — no reply hint for system messages", () => {
    const event = makeEvent({ id: "evt-3", by: "carol", data: { text: null } });
    expect(formatMessage(event)).toBe(
      "---\n**From:** carol\n**Group:** g_test\n**Received:** 2026-07-21T00:00:00Z\n\n(no text)",
    );
  });

  test("does NOT contain standby/wait instructions", () => {
    const event = makeEvent({ id: "evt-4", by: "dave", data: { text: "ping" } });
    const result = formatMessage(event);
    expect(result).not.toMatch(/\bstandby\b/i);
    // The only "wait" that may appear is in the user's message text, not in the format scaffolding
    const scaffolding = result.split("\n\n---\n")[1] ?? "";
    expect(scaffolding).not.toMatch(/\bwait\b/i);
  });

  test("includes one-line reply hint to use cccc_reply/cccc_send", () => {
    const event = makeEvent({ id: "evt-5", by: "alice", data: { text: "Hello" } });
    const output = formatMessage(event);
    expect(output).toContain("cccc_reply");
    expect(output).toContain("cccc_send");
    // Must be a single line, not a block
    const lines = output.split("\n");
    const replyLine = lines.find((l) => l.includes("cccc_reply") || l.includes("cccc_send"));
    expect(replyLine).toBe("Reply via cccc_reply or cccc_send.");
  });

  test("no reply hint for system messages with fallback text", () => {
    const event = makeEvent({ id: "evt-6", by: "system", data: {} });
    const output = formatMessage(event);
    expect(output).not.toContain("cccc_reply");
    expect(output).not.toContain("cccc_send");
    expect(output).not.toContain("Reply");
  });

  // ---- Provenance metadata ----

  test("includes sender in header", () => {
    const event = makeEvent({ id: "p1", by: "alice", data: { text: "hi" } });
    const output = formatMessage(event);
    expect(output).toContain("**From:** alice");
  });

  test("includes group in header", () => {
    const event = makeEvent({ id: "p2", by: "bob", data: { text: "hi" } });
    const output = formatMessage(event);
    expect(output).toContain("**Group:** g_test");
  });

  test("includes timestamp in header", () => {
    const event = makeEvent({ id: "p3", by: "carol", data: { text: "hi" } });
    const output = formatMessage(event);
    expect(output).toContain("**Received:** 2026-07-21T00:00:00Z");
  });

  test("includes reply-required flag when present", () => {
    const event = makeEvent({
      id: "p4",
      by: "dave",
      data: { text: "action needed", reply_required: true },
    });
    const output = formatMessage(event);
    expect(output).toContain("**Reply required**");
  });

  test("omits reply-required flag when not present", () => {
    const event = makeEvent({ id: "p5", by: "eve", data: { text: "normal" } });
    const output = formatMessage(event);
    expect(output).not.toContain("**Reply required**");
  });

  test("includes cross-group info when kind is chat.cross_group_receipt", () => {
    const event = makeEvent({
      id: "p6",
      by: "frank",
      kind: "chat.cross_group_receipt",
      data: { text: "forwarded", src_group_id: "other-group" },
    });
    const output = formatMessage(event);
    expect(output).toContain("Cross-group message from other-group");
  });

  test("omits cross-group info for normal chat.message", () => {
    const event = makeEvent({ id: "p7", by: "grace", data: { text: "normal" } });
    const output = formatMessage(event);
    expect(output).not.toMatch(/Cross-group message/);
  });

  test("includes attention priority when present", () => {
    const event = makeEvent({
      id: "p8",
      by: "heidi",
      data: { text: "urgent", priority: "attention" },
    });
    const output = formatMessage(event);
    expect(output).toContain("[ATTENTION]");
  });

  test("omits attention priority for normal priority", () => {
    const event = makeEvent({ id: "p9", by: "ivan", data: { text: "normal" } });
    const output = formatMessage(event);
    expect(output).not.toContain("[ATTENTION]");
  });

  test("includes all provenance fields together when applicable", () => {
    const event = makeEvent({
      id: "p10",
      by: "judy",
      kind: "chat.cross_group_receipt",
      data: {
        text: "combo",
        reply_required: true,
        priority: "attention",
        src_group_id: "remote-group",
      },
    });
    const output = formatMessage(event);
    expect(output).toContain("**From:** judy");
    expect(output).toContain("**Group:** g_test");
    expect(output).toContain("**Received:** 2026-07-21T00:00:00Z");
    expect(output).toContain("Cross-group message from remote-group");
    expect(output).toContain("**Reply required**");
    expect(output).toContain("[ATTENTION]");
  });

  test("uses unknown when by is absent", () => {
    const event = makeEvent({ id: "p11", by: undefined, data: { text: "anon" } });
    const output = formatMessage(event);
    expect(output).toContain("**From:** unknown");
  });
});

// ---- shouldDeliver ----

describe("shouldDeliver", () => {
  const actorId = "my-actor";

  test("delivers when `to` is absent (broadcast)", () => {
    expect(shouldDeliver(makeEvent({ id: "e1", data: { text: "hi" } }), actorId)).toBe(true);
  });

  test("delivers when `to` is empty array (broadcast)", () => {
    expect(shouldDeliver(makeEvent({ id: "e2", data: { text: "hi", to: [] } }), actorId)).toBe(
      true,
    );
  });

  test("delivers when `to` contains this actorId (direct message)", () => {
    expect(
      shouldDeliver(makeEvent({ id: "e3", data: { text: "hi", to: ["my-actor"] } }), actorId),
    ).toBe(true);
  });

  test("delivers when `to` contains a different actorId first and ours second", () => {
    expect(
      shouldDeliver(
        makeEvent({ id: "e4", data: { text: "hi", to: ["other-actor", "my-actor"] } }),
        actorId,
      ),
    ).toBe(true);
  });

  test('delivers when `to` contains "@all" (broadcast)', () => {
    expect(
      shouldDeliver(makeEvent({ id: "e5", data: { text: "hi", to: ["@all"] } }), actorId),
    ).toBe(true);
  });

  test('delivers when `to` contains "@peers"', () => {
    expect(
      shouldDeliver(makeEvent({ id: "e6", data: { text: "hi", to: ["@peers"] } }), actorId),
    ).toBe(true);
  });

  test('skips when `to` contains "@foreman"', () => {
    expect(
      shouldDeliver(makeEvent({ id: "e7", data: { text: "hi", to: ["@foreman"] } }), actorId),
    ).toBe(false);
  });

  test('skips when `to` contains "@user"', () => {
    expect(
      shouldDeliver(makeEvent({ id: "e8", data: { text: "hi", to: ["@user"] } }), actorId),
    ).toBe(false);
  });

  test("skips when `to` contains only another actor's ID", () => {
    expect(
      shouldDeliver(makeEvent({ id: "e9", data: { text: "hi", to: ["other-actor"] } }), actorId),
    ).toBe(false);
  });

  test("skips when `to` contains multiple non-matching entries", () => {
    expect(
      shouldDeliver(
        makeEvent({ id: "e10", data: { text: "hi", to: ["@foreman", "@user"] } }),
        actorId,
      ),
    ).toBe(false);
  });

  test("@all takes priority over other roles", () => {
    expect(
      shouldDeliver(
        makeEvent({ id: "e11", data: { text: "hi", to: ["@all", "@foreman"] } }),
        actorId,
      ),
    ).toBe(true);
  });

  test("skips when event is from our own actorId (own lifecycle broadcast)", () => {
    expect(
      shouldDeliver(
        makeEvent({ id: "e12", by: "my-actor", data: { text: "Agent my-actor online" } }),
        actorId,
      ),
    ).toBe(false);
  });

  test("delivers when event is from a different actorId", () => {
    expect(
      shouldDeliver(makeEvent({ id: "e13", by: "other-actor", data: { text: "Hello" } }), actorId),
    ).toBe(true);
  });

  test("skips when event has no text content (system message)", () => {
    expect(shouldDeliver(makeEvent({ id: "e14", data: {} }), actorId)).toBe(false);
  });

  test("skips when event has null text content", () => {
    expect(
      shouldDeliver(makeEvent({ id: "e15", data: { text: null, to: ["@all"] } }), actorId),
    ).toBe(false);
  });

  test("skips when event has empty string text content", () => {
    expect(
      shouldDeliver(makeEvent({ id: "e16", data: { text: "", to: ["my-actor"] } }), actorId),
    ).toBe(false);
  });
});

// ---- InboxPoller ----

describe("InboxPoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  test("poll() enqueues new messages via queue.enqueue", async () => {
    const { client, queue, enqueue } = createMocks();
    const events = [makeEvent({ id: "evt-1", by: "alice", data: { text: "Hello" } })];
    vi.mocked(client.inboxList).mockResolvedValue(events);

    const poller = new InboxPoller({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      pollIntervalMs: testPollInterval,
      queue,
    });

    await (poller as unknown as { poll(): Promise<void> }).poll();

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        content:
          "---\n**From:** alice\n**Group:** g_test\n**Received:** 2026-07-21T00:00:00Z\n\nHello\n\n---\nReply via cccc_reply or cccc_send.",
        details: {
          actorId: testActorId,
          groupId: testGroupId,
          eventId: "evt-1",
          by: "alice",
          text: "Hello",
        },
      }),
    );
  });

  test("poll() skips already-seen messages", async () => {
    const { client, queue, enqueue } = createMocks();
    const events = [makeEvent({ id: "evt-1", by: "alice", data: { text: "Hello" } })];
    vi.mocked(client.inboxList).mockResolvedValue(events);

    const poller = new InboxPoller({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      pollIntervalMs: testPollInterval,
      queue,
    });

    await (poller as unknown as { poll(): Promise<void> }).poll();
    expect(enqueue).toHaveBeenCalledTimes(1);

    await (poller as unknown as { poll(): Promise<void> }).poll();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  test("poll() onDelivered callback calls inboxMarkRead", async () => {
    const { client, queue, enqueue } = createMocks();
    const events = [makeEvent({ id: "evt-1", by: "alice" })];
    vi.mocked(client.inboxList).mockResolvedValue(events);
    vi.mocked(client.inboxMarkRead).mockResolvedValue(undefined);

    const poller = new InboxPoller({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      pollIntervalMs: testPollInterval,
      queue,
    });

    await (poller as unknown as { poll(): Promise<void> }).poll();

    // Extract and invoke the onDelivered callback from the enqueue call
    const call = enqueue.mock.calls[0][0] as { onDelivered?: () => void };
    call.onDelivered?.();

    expect(client.inboxMarkRead).toHaveBeenCalledTimes(1);
    expect(client.inboxMarkRead).toHaveBeenCalledWith({
      groupId: testGroupId,
      actorId: testActorId,
      eventId: "evt-1",
    });
  });

  test("start() begins polling on the configured interval", () => {
    const { client, queue } = createMocks();
    vi.mocked(client.inboxList).mockResolvedValue([]);

    const poller = new InboxPoller({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      pollIntervalMs: testPollInterval,
      queue,
    });

    poller.start();
    expect(client.inboxList).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(testPollInterval);
    expect(client.inboxList).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(testPollInterval);
    expect(client.inboxList).toHaveBeenCalledTimes(3);

    poller.stop();
  });

  test("stop() clears the timer", () => {
    const { client, queue } = createMocks();
    vi.mocked(client.inboxList).mockResolvedValue([]);

    const poller = new InboxPoller({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      pollIntervalMs: testPollInterval,
      queue,
    });

    poller.start();
    expect(client.inboxList).toHaveBeenCalledTimes(1);

    poller.stop();
    vi.advanceTimersByTime(testPollInterval * 3);
    expect(client.inboxList).toHaveBeenCalledTimes(1);
  });

  test("poll() does not re-throw errors from inboxList", async () => {
    const { client, queue } = createMocks();
    vi.mocked(client.inboxList).mockRejectedValue(new Error("network error"));

    const poller = new InboxPoller({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      pollIntervalMs: testPollInterval,
      queue,
    });

    await expect((poller as unknown as { poll(): Promise<void> }).poll()).resolves.toBeUndefined();
  });

  test("stop() clears seenIds", async () => {
    const { client, queue, enqueue } = createMocks();
    const events = [makeEvent({ id: "evt-1", by: "alice" })];
    vi.mocked(client.inboxList).mockResolvedValue(events);

    const poller = new InboxPoller({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      pollIntervalMs: testPollInterval,
      queue,
    });

    await (poller as unknown as { poll(): Promise<void> }).poll();
    expect(enqueue).toHaveBeenCalledTimes(1);

    poller.stop();

    await (poller as unknown as { poll(): Promise<void> }).poll();
    expect(enqueue).toHaveBeenCalledTimes(2);

    poller.stop();
  });

  test("poll() skips message addressed to another actor (not delivered, not marked read)", async () => {
    const { client, queue, enqueue } = createMocks();
    vi.mocked(client.inboxMarkRead).mockResolvedValue(undefined);
    const events = [
      makeEvent({ id: "evt-1", by: "alice", data: { text: "for me", to: ["test-actor"] } }),
      makeEvent({ id: "evt-2", by: "bob", data: { text: "for other", to: ["other-actor"] } }),
    ];
    vi.mocked(client.inboxList).mockResolvedValue(events);

    const poller = new InboxPoller({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      pollIntervalMs: testPollInterval,
      queue,
    });

    await (poller as unknown as { poll(): Promise<void> }).poll();

    // Only the message addressed to us should be enqueued
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ eventId: "evt-1" }),
      }),
    );
  });

  test("poll() skips @foreman messages entirely (no delivery, no mark-read)", async () => {
    const { client, queue, enqueue } = createMocks();
    vi.mocked(client.inboxMarkRead).mockResolvedValue(undefined);
    const events = [
      makeEvent({ id: "evt-1", by: "alice", data: { text: "general", to: ["@all"] } }),
      makeEvent({ id: "evt-2", by: "bob", data: { text: "foreman only", to: ["@foreman"] } }),
    ];
    vi.mocked(client.inboxList).mockResolvedValue(events);

    const poller = new InboxPoller({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      pollIntervalMs: testPollInterval,
      queue,
    });

    await (poller as unknown as { poll(): Promise<void> }).poll();

    // Only @all message should be enqueued
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ eventId: "evt-1" }),
      }),
    );
  });
});

test("calls onReconnect when consecutiveErrors resets to 0 after successful poll", async () => {
  const { client, queue } = createMocks();
  const onReconnect = vi.fn();

  // First call fails
  vi.mocked(client.inboxList).mockRejectedValueOnce(new Error("network error"));

  const poller = new InboxPoller({
    client,
    groupId: testGroupId,
    actorId: testActorId,
    pollIntervalMs: testPollInterval,
    queue,
    onReconnect,
  });

  // First poll fails → increment consecutiveErrors
  await (poller as unknown as { poll(): Promise<void> }).poll();
  expect(onReconnect).not.toHaveBeenCalled();

  // Second poll succeeds → reset consecutiveErrors
  vi.mocked(client.inboxList).mockResolvedValue([]);
  await (poller as unknown as { poll(): Promise<void> }).poll();
  expect(onReconnect).toHaveBeenCalledTimes(1);
});

test("onReconnect is not called on first successful poll (no prior errors)", async () => {
  const { client, queue } = createMocks();
  const onReconnect = vi.fn();
  vi.mocked(client.inboxList).mockResolvedValue([]);

  const poller = new InboxPoller({
    client,
    groupId: testGroupId,
    actorId: testActorId,
    pollIntervalMs: testPollInterval,
    queue,
    onReconnect,
  });

  await (poller as unknown as { poll(): Promise<void> }).poll();
  expect(onReconnect).not.toHaveBeenCalled();
});
