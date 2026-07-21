import { expect, test, vi } from "vite-plus/test";
import { CCCCBridgeClient, BridgeClientError } from "../src/client.ts";
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
    sendCrossGroup: vi.fn(),
    groups: vi.fn(),
    groupShow: vi.fn(),
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

// ---- sendCrossGroup ----

test("sendCrossGroup calls SDK with correct args", async () => {
  const mock = createMockClient();
  const sendCrossGroup = vi.fn().mockResolvedValue({
    src_event: { id: "src-evt-1", kind: "chat.message", group_id: "group-1", data: {} },
    dst_event: { id: "dst-evt-1", kind: "chat.message", group_id: "group-2", data: {} },
  });
  mock.sendCrossGroup = sendCrossGroup;
  const client = new CCCCBridgeClient(mock);
  await client.connect(testConfig);

  const result = await client.sendCrossGroup({
    groupId: "group-1",
    dstGroupId: "group-2",
    text: "Hello from group-1",
  });

  expect(result).toEqual({
    src_event: { id: "src-evt-1", kind: "chat.message", group_id: "group-1", data: {} },
    dst_event: { id: "dst-evt-1", kind: "chat.message", group_id: "group-2", data: {} },
  });
  expect(sendCrossGroup).toHaveBeenCalledWith({
    groupId: "group-1",
    dstGroupId: "group-2",
    text: "Hello from group-1",
  });
});

test("sendCrossGroup without connect throws BridgeClientError", async () => {
  const client = new CCCCBridgeClient();
  await expect(
    client.sendCrossGroup({ groupId: "g", dstGroupId: "g2", text: "hi" }),
  ).rejects.toThrow("Not connected");
});

test("sendCrossGroup wraps SDK error as BridgeClientError", async () => {
  const mock = createMockClient();
  mock.sendCrossGroup = vi.fn().mockRejectedValue(new Error("SDK error"));
  const client = new CCCCBridgeClient(mock);
  await client.connect(testConfig);

  await expect(
    client.sendCrossGroup({ groupId: "g", dstGroupId: "g2", text: "hi" }),
  ).rejects.toThrow("sendCrossGroup failed");
});

// ---- groups / groupShow ----

test("groups returns list from client", async () => {
  const mockClient = createMockClient();
  const groupsResult = {
    groups: [
      {
        group_id: "group-1",
        title: "Group 1",
        scopes: [{ scope_key: "/home/user/proj", url: "file:///home/user/proj" }],
      },
      { group_id: "group-2", title: "Group 2", scopes: [] },
    ],
  };
  (mockClient.groups as any).mockResolvedValue(groupsResult);
  const bridge = new CCCCBridgeClient(mockClient);
  await bridge.connect(testConfig);

  const result = await bridge.groups();

  expect(result).toEqual(groupsResult);
  expect(mockClient.groups).toHaveBeenCalledOnce();
});

test("groupShow returns group detail from client", async () => {
  const mockClient = createMockClient();
  const showResult = {
    group: {
      group_id: "group-1",
      title: "Group 1",
      scopes: [{ scope_key: "/home/user/proj", url: "file:///home/user/proj" }],
    },
  };
  (mockClient.groupShow as any).mockResolvedValue(showResult);
  const bridge = new CCCCBridgeClient(mockClient);
  await bridge.connect(testConfig);

  const result = await bridge.groupShow("group-1");

  expect(result).toEqual(showResult);
  expect(mockClient.groupShow).toHaveBeenCalledWith("group-1");
});

test("groups without connect throws BridgeClientError", async () => {
  const bridge = new CCCCBridgeClient(); // no injected client, no connect
  await expect(bridge.groups()).rejects.toThrow("Not connected");
});

test("groupShow without connect throws BridgeClientError", async () => {
  const bridge = new CCCCBridgeClient();
  await expect(bridge.groupShow("group-1")).rejects.toThrow("Not connected");
});

test("groups wraps SDK error as BridgeClientError", async () => {
  const mockClient = createMockClient();
  (mockClient.groups as any).mockRejectedValue(new Error("daemon error"));
  const bridge = new CCCCBridgeClient(mockClient);
  await bridge.connect(testConfig);

  await expect(bridge.groups()).rejects.toThrow(BridgeClientError);
});

test("groupShow wraps SDK error as BridgeClientError", async () => {
  const mockClient = createMockClient();
  (mockClient.groupShow as any).mockRejectedValue(new Error("daemon error"));
  const bridge = new CCCCBridgeClient(mockClient);
  await bridge.connect(testConfig);

  await expect(bridge.groupShow("group-1")).rejects.toThrow(BridgeClientError);
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
