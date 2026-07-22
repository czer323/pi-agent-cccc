// oxlint-disable typescript/unbound-method
import { expect, test, vi, describe, beforeEach } from "vite-plus/test";
import { InboxStreamer } from "../src/streamer.ts";
import type { InboxQueue } from "../src/inbox-queue.ts";
import type { CCCCBridgeClient } from "../src/client.ts";
import type { CCCSEvent } from "../src/types.ts";
import type { EventStreamItem, EventsStreamOptions } from "cccc-sdk";

const testGroupId = "test-group";
const testActorId = "test-actor";

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

function makeEventStreamItem(event: CCCSEvent): EventStreamItem {
  return { t: "event", event };
}

function makeHeartbeatStreamItem(): EventStreamItem {
  return { t: "heartbeat", ts: "2026-07-21T00:00:01Z" };
}

async function* mockGenerator(items: EventStreamItem[]) {
  for (const item of items) {
    yield item;
  }
}

function createMocks() {
  const eventsStream = vi.fn() as unknown as ReturnType<typeof vi.fn> &
    ((opts: EventsStreamOptions) => AsyncGenerator<EventStreamItem>);
  const client = { eventsStream } as unknown as CCCCBridgeClient;
  const enqueue = vi.fn();
  const queue = { enqueue } as unknown as InboxQueue;
  const onFallback = vi.fn();

  return { client, eventsStream, queue, enqueue, onFallback };
}

describe("InboxStreamer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  test("start() opens events stream and enqueues events", async () => {
    const { client, eventsStream, queue, enqueue, onFallback } = createMocks();
    const event = makeEvent({ id: "evt-1", by: "alice", data: { text: "Hello" } });
    eventsStream.mockReturnValue(mockGenerator([makeEventStreamItem(event)]));

    const streamer = new InboxStreamer({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      queue,
      onFallback,
    });

    streamer.start();
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("**From:** alice"),
        details: expect.objectContaining({
          groupId: testGroupId,
          eventId: "evt-1",
          by: "alice",
          text: "Hello",
        }),
      }),
    );

    streamer.stop();
  });

  test("ignores heartbeat items", async () => {
    const { client, eventsStream, queue, enqueue, onFallback } = createMocks();
    eventsStream.mockReturnValue(mockGenerator([makeHeartbeatStreamItem()]));

    const streamer = new InboxStreamer({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      queue,
      onFallback,
    });

    streamer.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(enqueue).not.toHaveBeenCalled();
    streamer.stop();
  });

  test("skips already-seen events", async () => {
    const { client, eventsStream, queue, enqueue, onFallback } = createMocks();
    const event = makeEvent({ id: "evt-1", by: "alice", data: { text: "Hello" } });
    eventsStream.mockReturnValue(
      mockGenerator([makeEventStreamItem(event), makeEventStreamItem(event)]),
    );

    const streamer = new InboxStreamer({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      queue,
      onFallback,
    });

    streamer.start();
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1)); // Only once despite seeing event twice
    streamer.stop();
  });

  test("stop() sets running to false", async () => {
    const { client, eventsStream, queue, onFallback } = createMocks();
    eventsStream.mockReturnValue(mockGenerator([]));

    const streamer = new InboxStreamer({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      queue,
      onFallback,
    });

    streamer.start();
    expect(streamer.running).toBe(true);
    streamer.stop();
    expect(streamer.running).toBe(false);
  });

  test("reconnects with exponential backoff after stream ends", async () => {
    const { client, eventsStream, queue, enqueue, onFallback } = createMocks();
    const event = makeEvent({ id: "evt-1", by: "alice", data: { text: "First" } });
    const event2 = makeEvent({ id: "evt-2", by: "bob", data: { text: "Second" } });
    eventsStream
      .mockReturnValueOnce(mockGenerator([makeEventStreamItem(event)]))
      .mockReturnValueOnce(mockGenerator([makeEventStreamItem(event2)]));

    const streamer = new InboxStreamer({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      queue,
      onFallback,
    });

    streamer.start();
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1100);
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(2));
    streamer.stop();
  });

  test("falls back to polling after max retries", async () => {
    const { client, eventsStream, queue, onFallback } = createMocks();
    eventsStream.mockReturnValue(mockGenerator([])); // Empty stream triggers immediate reconnect

    const streamer = new InboxStreamer({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      queue,
      onFallback,
    });

    streamer.start();
    // Total backoff: 1+2+4+8+30 = 45 seconds
    await vi.advanceTimersByTimeAsync(45000);
    expect(onFallback).toHaveBeenCalledTimes(1);
    streamer.stop();
  });

  test("handles stream errors gracefully", async () => {
    const { client, eventsStream, queue, enqueue, onFallback } = createMocks();
    const event = makeEvent({ id: "evt-1", by: "alice" });
    const event2 = makeEvent({ id: "evt-2", by: "bob" });
    // Both events in one generator
    eventsStream.mockReturnValue(
      mockGenerator([makeEventStreamItem(event), makeEventStreamItem(event2)]),
    );

    const streamer = new InboxStreamer({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      queue,
      onFallback,
    });

    streamer.start();
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(2));
    streamer.stop();
  });

  test("exposes seenIds for sharing with fallback poller", () => {
    const { client, queue, onFallback } = createMocks();

    const streamer = new InboxStreamer({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      queue,
      onFallback,
    });

    expect(streamer.seenIds).toBeDefined();
    expect(streamer.seenIds).toBeInstanceOf(Set);
  });

  test("caller can inject existing seenIds for dedup continuity", () => {
    const { client, queue, onFallback } = createMocks();
    const existingSeen = new Set<string>(["evt-1"]);

    const streamer = new InboxStreamer({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      queue,
      onFallback,
      seenIds: existingSeen,
    });

    expect(streamer.seenIds).toBe(existingSeen);
  });

  test("subscribes to chat.cross_group_receipt events", async () => {
    const { client, eventsStream, queue, enqueue, onFallback } = createMocks();
    const event = makeEvent({
      id: "evt-1",
      kind: "chat.cross_group_receipt",
      by: "alice",
      data: { text: "cross-group msg" },
    });
    eventsStream.mockReturnValue(mockGenerator([makeEventStreamItem(event)]));

    const streamer = new InboxStreamer({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      queue,
      onFallback,
    });

    streamer.start();
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    streamer.stop();
  });

  test("delivers chat.cross_group_receipt event with provenance", async () => {
    const { client, eventsStream, queue, enqueue, onFallback } = createMocks();
    const event = makeEvent({
      id: "evt-1",
      kind: "chat.cross_group_receipt",
      by: "alice",
      data: { text: "from other group", src_group_id: "other-group", src_event_id: "src-1" },
    });
    eventsStream.mockReturnValue(mockGenerator([makeEventStreamItem(event)]));

    const streamer = new InboxStreamer({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      queue,
      onFallback,
    });

    streamer.start();
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          srcGroupId: "other-group",
          srcEventId: "src-1",
        }),
      }),
    );
    streamer.stop();
  });

  test("delivers chat.message event with srcGroupId/srcEventId when present", async () => {
    const { client, eventsStream, queue, enqueue, onFallback } = createMocks();
    const event = makeEvent({
      id: "evt-1",
      kind: "chat.message",
      by: "alice",
      data: { text: "with provenance", src_group_id: "other-group", src_event_id: "src-1" },
    });
    eventsStream.mockReturnValue(mockGenerator([makeEventStreamItem(event)]));

    const streamer = new InboxStreamer({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      queue,
      onFallback,
    });

    streamer.start();
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          srcGroupId: "other-group",
          srcEventId: "src-1",
        }),
      }),
    );
    streamer.stop();
  });

  test("filters out events addressed to another actor", async () => {
    const { client, eventsStream, queue, enqueue, onFallback } = createMocks();
    const forMe = makeEvent({
      id: "evt-1",
      by: "alice",
      data: { text: "for me", to: ["test-actor"] },
    });
    const forOther = makeEvent({
      id: "evt-2",
      by: "bob",
      data: { text: "for other", to: ["other-actor"] },
    });
    eventsStream.mockReturnValue(
      mockGenerator([makeEventStreamItem(forMe), makeEventStreamItem(forOther)]),
    );

    const streamer = new InboxStreamer({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      queue,
      onFallback,
    });

    streamer.start();
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ eventId: "evt-1" }),
      }),
    );
    streamer.stop();
  });

  test("filters out @foreman events", async () => {
    const { client, eventsStream, queue, enqueue, onFallback } = createMocks();
    const general = makeEvent({
      id: "evt-1",
      by: "alice",
      data: { text: "general", to: ["@all"] },
    });
    const foremanOnly = makeEvent({
      id: "evt-2",
      by: "bob",
      data: { text: "foreman only", to: ["@foreman"] },
    });
    eventsStream.mockReturnValue(
      mockGenerator([makeEventStreamItem(general), makeEventStreamItem(foremanOnly)]),
    );

    const streamer = new InboxStreamer({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      queue,
      onFallback,
    });

    streamer.start();
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ eventId: "evt-1" }),
      }),
    );
    streamer.stop();
  });
});
