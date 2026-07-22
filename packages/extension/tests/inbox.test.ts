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
    kind: "chat.message",
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
      "New CCCC message from alice:\n\nHello world\n\n---\n## CCCC Reply Instructions\n\nIMPORTANT: Do NOT reply in this session/chat.\nYour response will be visible here automatically.\n\nUse the `cccc_reply` tool to reply to this specific message.\nUse the `cccc_send` tool to send a new message to the group.\n\nReply ONLY through CCCC tools. Do NOT reply in-session.",
    );
  });

  test("handles missing text with fallback", () => {
    const event = makeEvent({ id: "evt-2", by: "bob", data: {} });
    expect(formatMessage(event)).toBe(
      "New CCCC message from bob:\n\n(no text)\n\n---\n## CCCC Reply Instructions\n\nIMPORTANT: Do NOT reply in this session/chat.\nYour response will be visible here automatically.\n\nUse the `cccc_reply` tool to reply to this specific message.\nUse the `cccc_send` tool to send a new message to the group.\n\nReply ONLY through CCCC tools. Do NOT reply in-session.",
    );
  });

  test("handles null text with fallback", () => {
    const event = makeEvent({ id: "evt-3", by: "carol", data: { text: null } });
    expect(formatMessage(event)).toBe(
      "New CCCC message from carol:\n\n(no text)\n\n---\n## CCCC Reply Instructions\n\nIMPORTANT: Do NOT reply in this session/chat.\nYour response will be visible here automatically.\n\nUse the `cccc_reply` tool to reply to this specific message.\nUse the `cccc_send` tool to send a new message to the group.\n\nReply ONLY through CCCC tools. Do NOT reply in-session.",
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

  test("includes clear instruction to use cccc_reply/cccc_send and avoid in-session reply", () => {
    const event = makeEvent({ id: "evt-5", by: "alice", data: { text: "Hello" } });
    const output = formatMessage(event);
    expect(output).toContain("cccc_reply");
    expect(output).toContain("cccc_send");
    expect(output).toContain("Do NOT reply");
    expect(output).toContain("in-session");
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
          "New CCCC message from alice:\n\nHello\n\n---\n## CCCC Reply Instructions\n\nIMPORTANT: Do NOT reply in this session/chat.\nYour response will be visible here automatically.\n\nUse the `cccc_reply` tool to reply to this specific message.\nUse the `cccc_send` tool to send a new message to the group.\n\nReply ONLY through CCCC tools. Do NOT reply in-session.",
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
