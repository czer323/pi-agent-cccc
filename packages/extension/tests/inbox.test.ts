// oxlint-disable typescript/unbound-method
import { expect, test, vi, describe, beforeEach } from "vite-plus/test";
import { InboxPoller, formatMessage, shouldDeliver } from "../src/inbox.ts";
import type { CCCCBridgeClient } from "../src/client.ts";
import type { CCCSEvent } from "../src/types.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---- helpers ----

const testGroupId = "test-group";
const testActorId = "test-actor";
const testPollInterval = 100;

function makeEvent(overrides: Partial<CCCSEvent> & { id: string }): CCCSEvent {
  return {
    ts: overrides.ts ?? "2026-07-21T00:00:00Z",
    kind: overrides.kind ?? "chat.message",
    group_id: overrides.group_id ?? testGroupId,
    by: overrides.by ?? "sender-1",
    data: (overrides.data ?? { text: "Hello" }) as Record<string, unknown>,
    ...overrides,
  };
}

function createMocks() {
  const client = {
    inboxList: vi.fn(),
    inboxMarkRead: vi.fn(),
    registerActor: vi.fn(),
  } as unknown as CCCCBridgeClient;

  const sendMessage = vi.fn();
  const pi = { sendMessage } as unknown as ExtensionAPI;

  return { client, pi, sendMessage };
}

// ---- formatMessage ----

describe("formatMessage", () => {
  test("produces correct output with text", () => {
    const event = makeEvent({ id: "evt-1", by: "alice", data: { text: "Hello world" } });
    expect(formatMessage(event)).toBe("New CCCC message from alice:\n\nHello world");
  });

  test("handles missing text with fallback", () => {
    const event = makeEvent({ id: "evt-2", by: "bob", data: {} });
    expect(formatMessage(event)).toBe("New CCCC message from bob:\n\n(no text)");
  });

  test("handles null text with fallback", () => {
    const event = makeEvent({ id: "evt-3", by: "carol", data: { text: null } });
    expect(formatMessage(event)).toBe("New CCCC message from carol:\n\n(no text)");
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

  test("poll() delivers new messages via pi.sendMessage with triggerTurn: true", async () => {
    const { client, pi, sendMessage } = createMocks();
    const events = [makeEvent({ id: "evt-1", by: "alice", data: { text: "Hello" } })];
    vi.mocked(client.inboxList).mockResolvedValue(events);

    const poller = new InboxPoller({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      pollIntervalMs: testPollInterval,
      pi,
    });

    await (poller as unknown as { poll(): Promise<void> }).poll();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      {
        customType: "cccc-inbox",
        content: "New CCCC message from alice:\n\nHello",
        display: true,
        details: {
          groupId: testGroupId,
          eventId: "evt-1",
          by: "alice",
          text: "Hello",
        },
      },
      { triggerTurn: true },
    );
  });

  test("poll() skips already-seen messages", async () => {
    const { client, pi, sendMessage } = createMocks();
    const events = [makeEvent({ id: "evt-1", by: "alice", data: { text: "Hello" } })];
    vi.mocked(client.inboxList).mockResolvedValue(events);

    const poller = new InboxPoller({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      pollIntervalMs: testPollInterval,
      pi,
    });

    await (poller as unknown as { poll(): Promise<void> }).poll();
    expect(sendMessage).toHaveBeenCalledTimes(1);

    await (poller as unknown as { poll(): Promise<void> }).poll();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("poll() calls inboxMarkRead after delivery", async () => {
    const { client, pi } = createMocks();
    const events = [makeEvent({ id: "evt-1", by: "alice" })];
    vi.mocked(client.inboxList).mockResolvedValue(events);
    vi.mocked(client.inboxMarkRead).mockResolvedValue(undefined);

    const poller = new InboxPoller({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      pollIntervalMs: testPollInterval,
      pi,
    });

    await (poller as unknown as { poll(): Promise<void> }).poll();

    expect(client.inboxMarkRead).toHaveBeenCalledTimes(1);
    expect(client.inboxMarkRead).toHaveBeenCalledWith({
      groupId: testGroupId,
      actorId: testActorId,
      eventId: "evt-1",
    });
  });

  test("start() begins polling on the configured interval", () => {
    const { client, pi } = createMocks();
    vi.mocked(client.inboxList).mockResolvedValue([]);

    const poller = new InboxPoller({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      pollIntervalMs: testPollInterval,
      pi,
    });

    poller.start();

    // Should have called inboxList already (first tick)
    expect(client.inboxList).toHaveBeenCalledTimes(1);

    // Advance time — should fire again
    vi.advanceTimersByTime(testPollInterval);
    expect(client.inboxList).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(testPollInterval);
    expect(client.inboxList).toHaveBeenCalledTimes(3);

    poller.stop();
  });

  test("stop() clears the timer", () => {
    const { client, pi } = createMocks();
    vi.mocked(client.inboxList).mockResolvedValue([]);

    const poller = new InboxPoller({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      pollIntervalMs: testPollInterval,
      pi,
    });

    poller.start();
    expect(client.inboxList).toHaveBeenCalledTimes(1);

    poller.stop();

    // Advance time — should NOT fire again
    vi.advanceTimersByTime(testPollInterval * 3);
    expect(client.inboxList).toHaveBeenCalledTimes(1);
  });

  test("poll() continues after a message delivery error", async () => {
    const { client, pi, sendMessage } = createMocks();
    const event1 = makeEvent({ id: "evt-1", by: "alice", data: { text: "First" } });
    const event2 = makeEvent({ id: "evt-2", by: "bob", data: { text: "Second" } });

    vi.mocked(client.inboxList).mockResolvedValue([event1, event2]);
    sendMessage
      .mockRejectedValueOnce(new Error("delivery failed"))
      .mockResolvedValueOnce(undefined);

    const poller = new InboxPoller({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      pollIntervalMs: testPollInterval,
      pi,
    });

    await expect((poller as unknown as { poll(): Promise<void> }).poll()).resolves.toBeUndefined();

    // Both messages should have been attempted
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  test("poll() does not re-throw errors from inboxList", async () => {
    const { client, pi } = createMocks();
    vi.mocked(client.inboxList).mockRejectedValue(new Error("network error"));

    const poller = new InboxPoller({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      pollIntervalMs: testPollInterval,
      pi,
    });

    await expect((poller as unknown as { poll(): Promise<void> }).poll()).resolves.toBeUndefined();
  });

  test("stop() clears seenIds", async () => {
    const { client, pi, sendMessage } = createMocks();
    const events = [makeEvent({ id: "evt-1", by: "alice" })];
    vi.mocked(client.inboxList).mockResolvedValue(events);

    const poller = new InboxPoller({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      pollIntervalMs: testPollInterval,
      pi,
    });

    // First poll — deliver the message
    await (poller as unknown as { poll(): Promise<void> }).poll();
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // Stop — clears seenIds
    poller.stop();

    // Second poll after stop — should re-deliver since seenIds was cleared
    await (poller as unknown as { poll(): Promise<void> }).poll();
    expect(sendMessage).toHaveBeenCalledTimes(2);

    poller.stop();
  });

  test("poll() skips message addressed to another actor (not delivered, not marked read)", async () => {
    const { client, pi, sendMessage } = createMocks();
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
      pi,
    });

    await (poller as unknown as { poll(): Promise<void> }).poll();

    // Only the message for us should be delivered and marked read
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("for me") }),
      expect.anything(),
    );
    expect(client.inboxMarkRead).toHaveBeenCalledTimes(1);
    expect(client.inboxMarkRead).toHaveBeenCalledWith({
      groupId: testGroupId,
      actorId: testActorId,
      eventId: "evt-1",
    });
  });

  test("poll() skips @foreman messages entirely (no delivery, no mark-read)", async () => {
    const { client, pi, sendMessage } = createMocks();
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
      pi,
    });

    await (poller as unknown as { poll(): Promise<void> }).poll();

    // Only @all message should be delivered and marked read
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("general") }),
      expect.anything(),
    );
    expect(client.inboxMarkRead).toHaveBeenCalledTimes(1);
  });
});
