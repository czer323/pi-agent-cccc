// oxlint-disable typescript/unbound-method
import { expect, test, vi, describe, beforeEach } from "vite-plus/test";
import { InboxStreamer } from "../src/streamer.ts";
import type { CCCCBridgeClient } from "../src/client.ts";
import type { CCCSEvent } from "../src/types.ts";
import type { EventStreamItem, EventsStreamOptions } from "cccc-sdk";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const testGroupId = "test-group";
const testActorId = "test-actor";

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
  const eventsStream = vi.fn() as unknown as {
    (options: EventsStreamOptions): AsyncGenerator<EventStreamItem>;
    mockReturnValue: (val: AsyncGenerator<EventStreamItem>) => typeof eventsStream;
    mockReturnValueOnce: (val: AsyncGenerator<EventStreamItem>) => typeof eventsStream;
    mock: { calls: Array<Array<EventsStreamOptions>> };
  };

  const client = { eventsStream } as unknown as CCCCBridgeClient;
  const sendMessage = vi.fn();
  const pi = { sendMessage } as unknown as ExtensionAPI;
  const onFallback = vi.fn();

  return { client, eventsStream, pi, sendMessage, onFallback };
}

describe("InboxStreamer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  test("start() opens events stream and delivers events", async () => {
    const { client, eventsStream, pi, sendMessage, onFallback } = createMocks();
    const event = makeEvent({ id: "evt-1", by: "alice", data: { text: "Hello" } });
    eventsStream.mockReturnValue(mockGenerator([makeEventStreamItem(event)]));

    const streamer = new InboxStreamer({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      pi,
      onFallback,
    });
    streamer.start();

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    expect(sendMessage).toHaveBeenCalledWith(
      {
        customType: "cccc-inbox",
        content:
          "New CCCC message from alice:\n\nHello\n\n---\nReply using the cccc_send tool (registered by the bridge extension) so your reply is visible to all group members in the CCCC Web UI.",
        display: true,
        details: { groupId: testGroupId, eventId: "evt-1", by: "alice", text: "Hello" },
      },
      { triggerTurn: true },
    );
    streamer.stop();
  });

  test("ignores heartbeat items", async () => {
    const { client, eventsStream, pi, sendMessage, onFallback } = createMocks();
    eventsStream.mockReturnValue(
      mockGenerator([makeHeartbeatStreamItem(), makeEventStreamItem(makeEvent({ id: "evt-1" }))]),
    );

    const streamer = new InboxStreamer({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      pi,
      onFallback,
    });
    streamer.start();

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    streamer.stop();
  });

  test("skips already-seen events", async () => {
    const { client, eventsStream, pi, sendMessage, onFallback } = createMocks();
    const event = makeEvent({ id: "evt-1", by: "alice" });
    eventsStream.mockReturnValue(
      mockGenerator([makeEventStreamItem(event), makeEventStreamItem(event)]),
    );

    const streamer = new InboxStreamer({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      pi,
      onFallback,
    });
    streamer.start();

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    streamer.stop();
  });

  test("stop() sets running to false", async () => {
    const { client, eventsStream, onFallback } = createMocks();
    async function* infiniteGen() {
      while (true) {
        yield makeHeartbeatStreamItem();
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    eventsStream.mockReturnValue(infiniteGen());

    const streamer = new InboxStreamer({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      pi: {} as ExtensionAPI,
      onFallback,
    });
    streamer.start();
    await vi.advanceTimersByTimeAsync(50);
    streamer.stop();
    expect(streamer.running).toBe(false);
  });

  test("reconnects with exponential backoff after stream ends", async () => {
    const { client, eventsStream, pi, sendMessage, onFallback } = createMocks();
    eventsStream
      .mockReturnValueOnce(
        mockGenerator([makeEventStreamItem(makeEvent({ id: "evt-1", by: "alice" }))]),
      )
      .mockReturnValue(mockGenerator([makeEventStreamItem(makeEvent({ id: "evt-2", by: "bob" }))]));

    const streamer = new InboxStreamer({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      pi,
      onFallback,
    });
    streamer.start();

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1100);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    streamer.stop();
  });

  test("falls back to polling after max retries", async () => {
    const { client, eventsStream, onFallback } = createMocks();
    async function failingStream() {
      throw new Error("connection refused");
    }
    eventsStream.mockReturnValue(failingStream() as unknown as AsyncGenerator<EventStreamItem>);

    const streamer = new InboxStreamer({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      pi: {} as ExtensionAPI,
      onFallback,
    });
    streamer.start();

    for (const delay of [1_000, 2_000, 4_000, 8_000, 30_000]) {
      await vi.advanceTimersByTimeAsync(delay + 100);
    }
    expect(onFallback).toHaveBeenCalledTimes(1);
    streamer.stop();
  });

  test("handles delivery errors gracefully", async () => {
    const { client, eventsStream, sendMessage, onFallback } = createMocks();
    sendMessage
      .mockRejectedValueOnce(new Error("delivery failed"))
      .mockResolvedValueOnce(undefined);
    eventsStream.mockReturnValue(
      mockGenerator([
        makeEventStreamItem(makeEvent({ id: "evt-1", by: "alice", data: { text: "First" } })),
        makeEventStreamItem(makeEvent({ id: "evt-2", by: "bob", data: { text: "Second" } })),
      ]),
    );

    const streamer = new InboxStreamer({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      pi: { sendMessage } as unknown as ExtensionAPI,
      onFallback,
    });
    streamer.start();

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    streamer.stop();
  });

  test("exposes seenIds for sharing with fallback poller", () => {
    const { client, pi, onFallback } = createMocks();
    const streamer = new InboxStreamer({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      pi,
      onFallback,
    });
    expect(streamer.seenIds).toBeInstanceOf(Set);
    expect(streamer.seenIds.size).toBe(0);
  });

  test("caller can inject existing seenIds for dedup continuity", () => {
    const { client, pi, onFallback } = createMocks();
    const existingSeen = new Set<string>(["evt-1", "evt-2"]);
    const streamer = new InboxStreamer({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      pi,
      onFallback,
      seenIds: existingSeen,
    });
    expect(streamer.seenIds).toBe(existingSeen);
  });

  test("subscribes to chat.cross_group_receipt events", async () => {
    const { client, eventsStream, pi, onFallback } = createMocks();
    eventsStream.mockReturnValue(mockGenerator([]));

    const streamer = new InboxStreamer({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      pi,
      onFallback,
    });
    streamer.start();

    await vi.waitFor(() => expect(eventsStream).toHaveBeenCalledTimes(1));
    const callOptions = eventsStream.mock.calls[0][0];
    expect(callOptions.kinds).toContain("chat.message");
    expect(callOptions.kinds).toContain("chat.cross_group_receipt");
    streamer.stop();
  });

  test("delivers chat.cross_group_receipt event with provenance", async () => {
    const { client, eventsStream, pi, sendMessage, onFallback } = createMocks();
    const event = makeEvent({
      id: "evt-receipt-1",
      kind: "chat.cross_group_receipt",
      by: "bridge",
      data: {
        source_event_id: "orig-evt-1",
        dst_group_id: "group-2",
        status: "delivered",
      },
    });
    eventsStream.mockReturnValue(mockGenerator([makeEventStreamItem(event)]));

    const streamer = new InboxStreamer({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      pi,
      onFallback,
    });
    streamer.start();

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith(
      {
        customType: "cccc-inbox",
        content:
          "New CCCC message from bridge:\n\n(no text)\n\n---\nReply using the cccc_send tool (registered by the bridge extension) so your reply is visible to all group members in the CCCC Web UI.",
        display: true,
        details: {
          groupId: testGroupId,
          eventId: "evt-receipt-1",
          by: "bridge",
          text: "(no text)",
          srcGroupId: testGroupId,
          srcEventId: "orig-evt-1",
        },
      },
      { triggerTurn: true },
    );
    streamer.stop();
  });

  test("delivers chat.message event with srcGroupId/srcEventId when present", async () => {
    const { client, eventsStream, pi, sendMessage, onFallback } = createMocks();
    const event = makeEvent({
      id: "evt-fwd-1",
      kind: "chat.message",
      by: "hermes",
      data: {
        text: "Forwarded message",
        src_group_id: "group-origin",
        src_event_id: "orig-evt-42",
      },
    });
    eventsStream.mockReturnValue(mockGenerator([makeEventStreamItem(event)]));

    const streamer = new InboxStreamer({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      pi,
      onFallback,
    });
    streamer.start();

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith(
      {
        customType: "cccc-inbox",
        content:
          "New CCCC message from hermes:\n\nForwarded message\n\n---\nReply using the cccc_send tool (registered by the bridge extension) so your reply is visible to all group members in the CCCC Web UI.",
        display: true,
        details: {
          groupId: testGroupId,
          eventId: "evt-fwd-1",
          by: "hermes",
          text: "Forwarded message",
          srcGroupId: "group-origin",
          srcEventId: "orig-evt-42",
        },
      },
      { triggerTurn: true },
    );
    streamer.stop();
  });

  test("filters out events addressed to another actor", async () => {
    const { client, eventsStream, pi, sendMessage, onFallback } = createMocks();
    eventsStream.mockReturnValue(
      mockGenerator([
        makeEventStreamItem(
          makeEvent({ id: "evt-1", by: "alice", data: { text: "for me", to: ["test-actor"] } }),
        ),
        makeEventStreamItem(
          makeEvent({ id: "evt-2", by: "bob", data: { text: "for other", to: ["other-actor"] } }),
        ),
      ]),
    );

    const streamer = new InboxStreamer({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      pi,
      onFallback,
    });
    streamer.start();

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("for me") }),
      expect.anything(),
    );
    streamer.stop();
  });

  test("filters out @foreman events", async () => {
    const { client, eventsStream, pi, sendMessage, onFallback } = createMocks();
    eventsStream.mockReturnValue(
      mockGenerator([
        makeEventStreamItem(
          makeEvent({ id: "evt-1", by: "alice", data: { text: "general", to: ["@all"] } }),
        ),
        makeEventStreamItem(
          makeEvent({ id: "evt-2", by: "bob", data: { text: "foreman only", to: ["@foreman"] } }),
        ),
      ]),
    );

    const streamer = new InboxStreamer({
      client,
      groupId: testGroupId,
      actorId: testActorId,
      pi,
      onFallback,
    });
    streamer.start();

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("general") }),
      expect.anything(),
    );
    streamer.stop();
  });
});
