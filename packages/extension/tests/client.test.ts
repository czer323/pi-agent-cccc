import { expect, test, vi } from "vite-plus/test";
import { CCCCBridgeClient } from "../src/client.ts";
import type { CCCCClientLike, BridgeClientConfig } from "../src/types.ts";

// ---- helpers ----

const testConfig: BridgeClientConfig = {
  host: "192.168.7.163",
  port: 9765,
  timeoutMs: 30000,
};

function createMockClient(): CCCCClientLike {
  return {
    actorAdd: vi.fn(),
    inboxList: vi.fn(),
    inboxMarkRead: vi.fn(),
    eventsStream: vi.fn() as any,
  };
}

// ---- connect ----

test("connect with injected client resolves", async () => {
  const mock = createMockClient();
  const client = new CCCCBridgeClient(mock);
  await expect(client.connect(testConfig)).resolves.toBeUndefined();
});

// ---- registerActor ----

test("registerActor calls actorAdd and returns actorId", async () => {
  const mock = createMockClient();
  const actorAdd = vi.fn().mockResolvedValue({ actor_id: "actor-1" });
  mock.actorAdd = actorAdd;
  const client = new CCCCBridgeClient(mock);
  await client.connect(testConfig);

  const result = await client.registerActor({
    groupId: "group-1",
    actorId: "actor-1",
    runtime: "python",
    runner: "runner-1",
    title: "Test Actor",
  });

  expect(result).toEqual({ actorId: "actor-1" });
  expect(actorAdd).toHaveBeenCalledWith({
    groupId: "group-1",
    actorId: "actor-1",
    runtime: "python",
    runner: "runner-1",
    title: "Test Actor",
  });
});

test("registerActor with minimal params", async () => {
  const mock = createMockClient();
  const actorAdd = vi.fn().mockResolvedValue({ actor_id: "actor-2" });
  mock.actorAdd = actorAdd;
  const client = new CCCCBridgeClient(mock);
  await client.connect(testConfig);

  const result = await client.registerActor({
    groupId: "group-1",
    actorId: "actor-2",
  });

  expect(result).toEqual({ actorId: "actor-2" });
  expect(actorAdd).toHaveBeenCalledWith({
    groupId: "group-1",
    actorId: "actor-2",
  });
});
// ---- inboxList ----

test("inboxList returns messages array", async () => {
  const messages = [
    { id: "evt-1", ts: "2024-01-01T00:00:00Z", kind: "test", group_id: "group-1", data: {} },
    { id: "evt-2", ts: "2024-01-01T00:01:00Z", kind: "test", group_id: "group-1", data: {} },
  ];
  const mock = createMockClient();
  const inboxList = vi.fn().mockResolvedValue({
    messages,
    cursor: { event_id: "evt-2", ts: "2024-01-01T00:01:00Z" },
  });
  mock.inboxList = inboxList;
  const client = new CCCCBridgeClient(mock);
  await client.connect(testConfig);

  const result = await client.inboxList({ groupId: "group-1", actorId: "actor-1", limit: 10 });

  expect(result).toEqual(messages);
  expect(inboxList).toHaveBeenCalledWith({
    groupId: "group-1",
    actorId: "actor-1",
    limit: 10,
  });
});

test("inboxList without limit", async () => {
  const mock = createMockClient();
  const inboxList = vi.fn().mockResolvedValue({ messages: [] });
  mock.inboxList = inboxList;
  const client = new CCCCBridgeClient(mock);
  await client.connect(testConfig);

  const result = await client.inboxList({ groupId: "group-1", actorId: "actor-1" });

  expect(result).toEqual([]);
  expect(inboxList).toHaveBeenCalledWith({
    groupId: "group-1",
    actorId: "actor-1",
    limit: undefined,
  });
});

test("inboxMarkRead calls SDK with correct positional args", async () => {
  const mock = createMockClient();
  const inboxMarkRead = vi.fn().mockResolvedValue({});
  mock.inboxMarkRead = inboxMarkRead;
  const client = new CCCCBridgeClient(mock);
  await client.connect(testConfig);

  await client.inboxMarkRead({ groupId: "group-1", actorId: "actor-1", eventId: "evt-1" });

  expect(inboxMarkRead).toHaveBeenCalledWith("group-1", "actor-1", "evt-1");
});

// ---- disconnect ----

test("disconnect clears client and subsequent calls throw", async () => {
  const mock = createMockClient();
  const client = new CCCCBridgeClient(mock);
  await client.connect(testConfig);
  client.disconnect();

  await expect(client.registerActor({ groupId: "g", actorId: "a" })).rejects.toThrow(
    "Not connected",
  );
});

// ---- error wrapping ----

test("registerActor wraps SDK error as BridgeClientError", async () => {
  const mock = createMockClient();
  mock.actorAdd = vi.fn().mockRejectedValue(new Error("SDK error"));
  const client = new CCCCBridgeClient(mock);
  await client.connect(testConfig);

  await expect(client.registerActor({ groupId: "g", actorId: "a" })).rejects.toThrow(
    "registerActor failed",
  );
});

test("inboxList wraps SDK error as BridgeClientError", async () => {
  const mock = createMockClient();
  mock.inboxList = vi.fn().mockRejectedValue(new Error("SDK error"));
  const client = new CCCCBridgeClient(mock);
  await client.connect(testConfig);

  await expect(client.inboxList({ groupId: "g", actorId: "a" })).rejects.toThrow(
    "inboxList failed",
  );
});

test("inboxMarkRead wraps SDK error as BridgeClientError", async () => {
  const mock = createMockClient();
  mock.inboxMarkRead = vi.fn().mockRejectedValue(new Error("SDK error"));
  const client = new CCCCBridgeClient(mock);
  await client.connect(testConfig);

  await expect(client.inboxMarkRead({ groupId: "g", actorId: "a", eventId: "e" })).rejects.toThrow(
    "inboxMarkRead failed",
  );
});

// ---- not connected ----

test("registerActor without connect throws BridgeClientError", async () => {
  const client = new CCCCBridgeClient();
  await expect(client.registerActor({ groupId: "g", actorId: "a" })).rejects.toThrow(
    "Not connected",
  );
});

test("inboxList without connect throws BridgeClientError", async () => {
  const client = new CCCCBridgeClient();
  await expect(client.inboxList({ groupId: "g", actorId: "a" })).rejects.toThrow("Not connected");
});

test("inboxMarkRead without connect throws BridgeClientError", async () => {
  const client = new CCCCBridgeClient();
  await expect(client.inboxMarkRead({ groupId: "g", actorId: "a", eventId: "e" })).rejects.toThrow(
    "Not connected",
  );
});
