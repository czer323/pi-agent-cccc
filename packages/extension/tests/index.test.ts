import { vi, expect, test, beforeEach } from "vite-plus/test";
import mod from "../src/index.ts";

// ---------- hoisted mock fns (shared between vi.mock factories and tests) ----------

const {
  mockRegisterActor,
  mockReply,
  mockSend,
  mockLoadConfig,
  mockConnect,
  mockDisconnect,
  mockEnsureRegistered,
  mockStreamerStart,
  mockStreamerStop,
  mockPollerStart,
  mockPollerStop,
  mockDiscoverGroups,
  mockActorRemove,
} = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockConnect: vi.fn().mockResolvedValue(undefined),
  mockDisconnect: vi.fn(),
  mockEnsureRegistered: vi.fn(),
  mockStreamerStart: vi.fn(),
  mockStreamerStop: vi.fn(),
  mockPollerStart: vi.fn(),
  mockPollerStop: vi.fn(),
  mockDiscoverGroups: vi.fn(),
  mockActorRemove: vi.fn().mockResolvedValue(undefined),
  mockRegisterActor: vi.fn().mockResolvedValue({ actorId: "child-actor-id" }),
  mockReply: vi.fn().mockResolvedValue({ event: { id: "reply-evt-1" }, ack_event: null }),
  mockSend: vi.fn().mockResolvedValue({ event: { id: "evt-1" }, ack_event: null }),
}));

// ---------- module mocks ----------

vi.mock("../src/config.ts", () => ({
  loadConfig: mockLoadConfig,
}));

vi.mock("../src/client.ts", () => ({
  // Must use a regular function (not arrow) so it works with `new CCCCBridgeClient()`
  CCCCBridgeClient: vi.fn(function () {
    return {
      connect: mockConnect,
      disconnect: mockDisconnect,
      registerActor: mockRegisterActor,
  mockReply,
      actorRemove: mockActorRemove,
      send: mockSend,
      reply: mockReply,
    };
  }),
  BridgeClientError: class BridgeClientError extends Error {
    constructor(m: string) {
      super(m);
      this.name = "BridgeClientError";
    }
  },
  defaultBridgeConfig: vi.fn(() => ({ host: "localhost", port: 9765, timeoutMs: 30000 })),
}));

vi.mock("../src/actor.ts", () => ({
  ensureRegistered: mockEnsureRegistered,
}));

vi.mock("../src/inbox.ts", () => ({
  // Must use a regular function (not arrow) so it works with `new InboxPoller()`
  InboxPoller: vi.fn(function () {
    return { start: mockPollerStart, stop: mockPollerStop };
  }),
}));

vi.mock("../src/streamer.ts", () => ({
  // Must use a regular function (not arrow) so it works with `new InboxStreamer()`
  InboxStreamer: vi.fn(function () {
    return { start: mockStreamerStart, stop: mockStreamerStop };
  }),
}));

vi.mock("../src/discovery.ts", () => ({
  discoverGroups: mockDiscoverGroups,
}));

// ---------- helpers ----------

beforeEach(() => {
  vi.resetAllMocks();
  mockConnect.mockResolvedValue(undefined);
  mockSend.mockResolvedValue({ event: { id: "evt-1" }, ack_event: null });
  mockReply.mockResolvedValue({ event: { id: "reply-evt-1" }, ack_event: null });
  // Clean any CCCC_PARENT_ACTOR_* env vars between tests
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("CCCC_PARENT_ACTOR_")) {
      delete process.env[key];
    }
  }
});

function createMockPi() {
  const handlers = new Map<string, Function>();
  const notify = vi.fn();
  const setStatus = vi.fn();
  const registeredTools: any[] = [];
  const pi: Record<string, unknown> = {
    on: vi.fn((event: string, handler: Function) => {
      handlers.set(event, handler);
    }),
    registerTool: vi.fn((tool: any) => {
      registeredTools.push(tool);
    }),
    _handlers: handlers,
    _notify: notify,
    _setStatus: setStatus,
    _registeredTools: registeredTools,
  };
  return pi as any;
}

function triggerSessionStart(pi: any, hasUI = false) {
  const handler = pi._handlers.get("session_start");
  if (!handler) throw new Error("session_start handler not registered");
  return handler(
    {},
    {
      hasUI,
      ui: {
        notify: pi._notify,
        setStatus: pi._setStatus,
      },
    },
  );
}

function triggerSessionShutdown(pi: any) {
  const handler = pi._handlers.get("session_shutdown");
  if (!handler) throw new Error("session_shutdown handler not registered");
  return handler();
}

// ---------- tests ----------

test("default export is a function", () => {
  expect(typeof mod).toBe("function");
});

test("inert when groups array is empty", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: [],
    actorId: null,
    pollIntervalMs: 3000,
  });

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);

  expect(mockConnect).not.toHaveBeenCalled();
  expect(mockEnsureRegistered).not.toHaveBeenCalled();
  expect(mockStreamerStart).not.toHaveBeenCalled();
});

test("single group startup connects, registers, starts streamer", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: ["test-group"],
    actorId: null,
    pollIntervalMs: 3000,
  });
  mockEnsureRegistered.mockResolvedValue("actor-123");

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);

  expect(mockConnect).toHaveBeenCalledTimes(1);
  expect(mockEnsureRegistered).toHaveBeenCalledTimes(1);
  expect(mockStreamerStart).toHaveBeenCalledTimes(1);
  expect(mockPollerStart).not.toHaveBeenCalled(); // poller only starts as fallback
});

test("multi-group startup connects, registers, starts streamer per group", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: ["group-a", "group-b", "group-c"],
    actorId: null,
    pollIntervalMs: 3000,
  });
  mockEnsureRegistered.mockResolvedValue("actor-123");

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);

  expect(mockConnect).toHaveBeenCalledTimes(3);
  expect(mockEnsureRegistered).toHaveBeenCalledTimes(3);
  expect(mockStreamerStart).toHaveBeenCalledTimes(3);
  expect(mockPollerStart).not.toHaveBeenCalled();
});

test("connection failure in one group does not block others", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: ["good-group", "bad-group"],
    actorId: null,
    pollIntervalMs: 3000,
  });
  mockEnsureRegistered.mockResolvedValue("actor-123");
  // Second connect call fails
  mockConnect.mockRejectedValueOnce(new Error("ECONNREFUSED"));

  const pi = createMockPi();
  mod(pi);
  await expect(triggerSessionStart(pi)).resolves.toBeUndefined();

  // Both groups tried to connect
  expect(mockConnect).toHaveBeenCalledTimes(2);
  // Only one group succeeded — one streamer started
  expect(mockStreamerStart).toHaveBeenCalledTimes(1);
  expect(mockPollerStart).not.toHaveBeenCalled();
});

test("connection failure degrades gracefully", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: ["test-group"],
    actorId: null,
    pollIntervalMs: 3000,
  });
  mockConnect.mockRejectedValue(new Error("ECONNREFUSED"));

  const pi = createMockPi();
  mod(pi);
  await expect(triggerSessionStart(pi)).resolves.toBeUndefined();

  expect(mockConnect).toHaveBeenCalledTimes(1);
  expect(mockEnsureRegistered).not.toHaveBeenCalled();
  expect(mockStreamerStart).not.toHaveBeenCalled();
});

// ---------- shutdown tests ----------

test("session_shutdown removes actor before disconnecting for single group", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: ["test-group"],
    actorId: null,
    pollIntervalMs: 3000,
  });
  mockEnsureRegistered.mockResolvedValue("actor-123");

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);
  expect(mockStreamerStart).toHaveBeenCalledTimes(1);

  await triggerSessionShutdown(pi);

  expect(mockActorRemove).toHaveBeenCalledWith("test-group", "actor-123");
  expect(mockStreamerStop).toHaveBeenCalledTimes(1);
  expect(mockDisconnect).toHaveBeenCalledTimes(1);
});

test("session_shutdown stops all streamers and disconnects all clients for multi-group", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: ["group-a", "group-b"],
    actorId: null,
    pollIntervalMs: 3000,
  });
  mockEnsureRegistered.mockResolvedValue("actor-123");

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);
  expect(mockStreamerStart).toHaveBeenCalledTimes(2);

  await triggerSessionShutdown(pi);

  expect(mockActorRemove).toHaveBeenCalledTimes(2);
  expect(mockActorRemove).toHaveBeenCalledWith("group-a", "actor-123");
  expect(mockActorRemove).toHaveBeenCalledWith("group-b", "actor-123");
  expect(mockStreamerStop).toHaveBeenCalledTimes(2);
  expect(mockDisconnect).toHaveBeenCalledTimes(2);
});

test("session_shutdown actorRemove failure logs but does not block shutdown", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: ["test-group"],
    actorId: null,
    pollIntervalMs: 3000,
  });
  mockEnsureRegistered.mockResolvedValue("actor-123");
  mockActorRemove.mockRejectedValue(new Error("daemon error"));

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);

  await expect(triggerSessionShutdown(pi)).resolves.toBeUndefined();

  expect(mockActorRemove).toHaveBeenCalledTimes(1);
  expect(mockStreamerStop).toHaveBeenCalledTimes(1);
  expect(mockDisconnect).toHaveBeenCalledTimes(1);
});

// ---------- UI tests ----------

test("UI calls are guarded by ctx.hasUI", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: ["test-group"],
    actorId: null,
    pollIntervalMs: 3000,
  });
  mockEnsureRegistered.mockResolvedValue("actor-123");

  const pi = createMockPi();
  mod(pi);

  // When hasUI is true, setStatus and notify should be called with success
  await triggerSessionStart(pi, true);
  expect(pi._setStatus).toHaveBeenCalledWith("cccc", "connected");
  expect(pi._notify).toHaveBeenCalledWith("CCCC bridge connected (1 group)", "info");
});

test("UI notifies for multi-group connection when hasUI is true", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: ["group-a", "group-b"],
    actorId: null,
    pollIntervalMs: 3000,
  });
  mockEnsureRegistered.mockResolvedValue("actor-123");

  const pi = createMockPi();
  mod(pi);

  await triggerSessionStart(pi, true);
  expect(pi._setStatus).toHaveBeenCalledWith("cccc", "connected");
  expect(pi._notify).toHaveBeenCalledWith("CCCC bridge connected (2 groups)", "info");
});

test("UI calls notify on connection failure when hasUI is true", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: ["test-group"],
    actorId: null,
    pollIntervalMs: 3000,
  });
  mockConnect.mockRejectedValue(new Error("ECONNREFUSED"));

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi, true);

  expect(pi._notify).toHaveBeenCalled();
  expect(pi._setStatus).not.toHaveBeenCalled(); // no connections succeeded
});

// ---------- auto-discovery tests ----------

test("auto-discovery triggers when groups empty and autoDiscover is true", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: [],
    actorId: null,
    pollIntervalMs: 3000,
    autoDiscover: true,
    defaultGroupId: null,
  });
  mockDiscoverGroups.mockResolvedValue(["discovered-group"]);
  mockEnsureRegistered.mockResolvedValue("actor-123");

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);

  expect(mockDiscoverGroups).toHaveBeenCalledOnce();
  // 1 discovery client + 1 per-group client
  expect(mockConnect).toHaveBeenCalledTimes(2);
  expect(mockEnsureRegistered).toHaveBeenCalledTimes(1);
  expect(mockStreamerStart).toHaveBeenCalledTimes(1);
});

test("auto-discovery connects to all discovered groups", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: [],
    actorId: null,
    pollIntervalMs: 3000,
    autoDiscover: true,
    defaultGroupId: null,
  });
  mockDiscoverGroups.mockResolvedValue(["group-a", "group-b"]);
  mockEnsureRegistered.mockResolvedValue("actor-123");

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);

  expect(mockDiscoverGroups).toHaveBeenCalledOnce();
  // 1 discovery client + 2 per-group clients
  expect(mockConnect).toHaveBeenCalledTimes(3);
  expect(mockStreamerStart).toHaveBeenCalledTimes(2);
});

test("auto-discovery falls back to defaultGroupId when no matches found", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: [],
    actorId: null,
    pollIntervalMs: 3000,
    autoDiscover: true,
    defaultGroupId: "lobby",
  });
  mockDiscoverGroups.mockResolvedValue([]);
  mockEnsureRegistered.mockResolvedValue("actor-123");

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);

  expect(mockDiscoverGroups).toHaveBeenCalledOnce();
  // 1 discovery client + 1 default group client
  expect(mockConnect).toHaveBeenCalledTimes(2);
  expect(mockEnsureRegistered).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ defaultGroupId: "lobby" }),
    "lobby",
  );
});

test("auto-discovery with no matches and no default stays inert", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: [],
    actorId: null,
    pollIntervalMs: 3000,
    autoDiscover: true,
    defaultGroupId: null,
  });
  mockDiscoverGroups.mockResolvedValue([]);

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);

  expect(mockDiscoverGroups).toHaveBeenCalledOnce();
  // Discovery client connects then disconnects — no per-group clients
  expect(mockConnect).toHaveBeenCalledTimes(1);
  expect(mockStreamerStart).not.toHaveBeenCalled();
});

test("auto-discovery failure skips gracefully and stays inert", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: [],
    actorId: null,
    pollIntervalMs: 3000,
    autoDiscover: true,
    defaultGroupId: null,
  });
  mockDiscoverGroups.mockRejectedValue(new Error("daemon unreachable"));

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);

  expect(mockDiscoverGroups).toHaveBeenCalledOnce();
  // Discovery client connects before discoverGroups throws
  expect(mockConnect).toHaveBeenCalledTimes(1);
  expect(mockStreamerStart).not.toHaveBeenCalled();
});

test("autoDiscover false with empty groups stays inert without discovery attempt", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: [],
    actorId: null,
    pollIntervalMs: 3000,
    autoDiscover: false,
    defaultGroupId: null,
  });

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);

  expect(mockDiscoverGroups).not.toHaveBeenCalled();
  expect(mockConnect).not.toHaveBeenCalled();
});

test("explicit groups take precedence over auto-discovery", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: ["explicit-group"],
    actorId: null,
    pollIntervalMs: 3000,
    autoDiscover: true,
    defaultGroupId: null,
  });
  mockEnsureRegistered.mockResolvedValue("actor-123");

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);

  expect(mockDiscoverGroups).not.toHaveBeenCalled();
  expect(mockConnect).toHaveBeenCalledTimes(1);
  expect(mockStreamerStart).toHaveBeenCalledTimes(1);
});

// ---------- sub-agent tests ----------

test("sub-agent detects parent via env var and registers child actor", async () => {
  process.env["CCCC_PARENT_ACTOR_test-group"] = "parent-actor-123";
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: ["test-group"],
    actorId: null,
    pollIntervalMs: 3000,
  });

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);

  // Connect should be called
  expect(mockConnect).toHaveBeenCalledTimes(1);
  // registerActor should be called for child registration
  expect(mockRegisterActor).toHaveBeenCalledTimes(1);
  expect(mockRegisterActor).toHaveBeenCalledWith(
    expect.objectContaining({
      groupId: "test-group",
      runtime: "custom",
      runner: "headless",
      title: "Pi Sub-Agent",
    }),
  );
  // send should announce to parent
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledWith(
    expect.objectContaining({
      groupId: "test-group",
      to: ["parent-actor-123"],
    }),
  );
  // Should NOT start streamer/poller (sub-agent is ephemeral)
  expect(mockStreamerStart).not.toHaveBeenCalled();
  expect(mockPollerStart).not.toHaveBeenCalled();
  // Should NOT call ensureRegistered (uses parent env var route)
  expect(mockEnsureRegistered).not.toHaveBeenCalled();
});

test("sub-agent skips groups without parent env var", async () => {
  // Only set parent for one group out of two
  process.env["CCCC_PARENT_ACTOR_group-a"] = "parent-a";
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: ["group-a", "group-b"],
    actorId: null,
    pollIntervalMs: 3000,
  });

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);

  // Should only process group-a (has parent env var)
  expect(mockConnect).toHaveBeenCalledTimes(1);
  expect(mockRegisterActor).toHaveBeenCalledTimes(1);
  expect(mockRegisterActor).toHaveBeenCalledWith(expect.objectContaining({ groupId: "group-a" }));
  expect(mockSend).toHaveBeenCalledTimes(1);
});

test("sub-agent child actor ID derives from parent", async () => {
  process.env["CCCC_PARENT_ACTOR_test-group"] = "parent-actor-123";
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: ["test-group"],
    actorId: null,
    pollIntervalMs: 3000,
  });

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);

  expect(mockRegisterActor).toHaveBeenCalledTimes(1);
  const callArg = mockRegisterActor.mock.calls[0][0];
  expect(callArg.actorId).toMatch(/^parent-actor-123-child-/);
});

test("sub-agent failure does not crash", async () => {
  process.env["CCCC_PARENT_ACTOR_test-group"] = "parent-actor-123";
  mockConnect.mockRejectedValue(new Error("ECONNREFUSED"));
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: ["test-group"],
    actorId: null,
    pollIntervalMs: 3000,
  });

  const pi = createMockPi();
  mod(pi);
  await expect(triggerSessionStart(pi)).resolves.toBeUndefined();

  expect(mockConnect).toHaveBeenCalledTimes(1);
  expect(mockRegisterActor).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
});

test("parent session sets env var for future sub-agents", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: ["test-group"],
    actorId: null,
    pollIntervalMs: 3000,
  });
  mockEnsureRegistered.mockResolvedValue("parent-actor-123");

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);

  // Parent session should set env var for sub-agents
  expect(process.env["CCCC_PARENT_ACTOR_test-group"]).toBe("parent-actor-123");
});

// ---------- tool registration tests ----------

test("registers cccc_send and cccc_reply tools on parent session_start", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: ["test-group"],
    actorId: null,
    pollIntervalMs: 3000,
  });
  mockEnsureRegistered.mockResolvedValue("actor-123");

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);

  expect(pi.registerTool).toHaveBeenCalledTimes(2);
  const toolNames = pi._registeredTools.map((t: any) => t.name);
  expect(toolNames).toContain("cccc_send");
  expect(toolNames).toContain("cccc_reply");
});

test("cccc_send tool has correct parameter schema", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: ["test-group"],
    actorId: null,
    pollIntervalMs: 3000,
  });
  mockEnsureRegistered.mockResolvedValue("actor-123");

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);

  const sendTool = pi._registeredTools.find((t: any) => t.name === "cccc_send");
  expect(sendTool).toBeDefined();
  // parameters is a TypeBox schema object with property shape
  const props = sendTool.parameters.properties;
  expect(props).toBeDefined();
  expect(props.text).toBeDefined();
  expect(props.groupId).toBeDefined();
  expect(props.to).toBeDefined();
});

test("cccc_send tool execute calls client.send with correct parameters", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: ["test-group"],
    actorId: null,
    pollIntervalMs: 3000,
  });
  mockEnsureRegistered.mockResolvedValue("actor-123");

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);

  const sendTool = pi._registeredTools.find((t: any) => t.name === "cccc_send");
  const result = await sendTool.execute("call-1", { text: "hello" }, undefined, undefined, {});

  expect(mockSend).toHaveBeenCalledWith({
    groupId: "test-group",
    text: "hello",
    to: undefined,
  });
  expect(result.content[0].text).toContain("Message sent");
  expect(result.details.eventId).toBe("evt-1");
});

test("cccc_send tool respects custom groupId and to parameters", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: ["group-a", "group-b"],
    actorId: null,
    pollIntervalMs: 3000,
  });
  mockEnsureRegistered.mockResolvedValue("actor-123");

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);

  const sendTool = pi._registeredTools.find((t: any) => t.name === "cccc_send");
  await sendTool.execute(
    "call-1",
    { text: "hi", groupId: "group-b", to: "@all" },
    undefined,
    undefined,
    {},
  );

  expect(mockSend).toHaveBeenCalledWith({
    groupId: "group-b",
    text: "hi",
    to: ["@all"],
  });
});

test("cccc_reply tool has correct parameter schema", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: ["test-group"],
    actorId: null,
    pollIntervalMs: 3000,
  });
  mockEnsureRegistered.mockResolvedValue("actor-123");

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);

  const replyTool = pi._registeredTools.find((t: any) => t.name === "cccc_reply");
  expect(replyTool).toBeDefined();
  const props = replyTool.parameters.properties;
  expect(props).toBeDefined();
  expect(props.text).toBeDefined();
  expect(props.eventId).toBeDefined();
  expect(props.groupId).toBeDefined();
});

test("cccc_reply tool execute calls client.reply with correct parameters", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: ["test-group"],
    actorId: null,
    pollIntervalMs: 3000,
  });
  mockEnsureRegistered.mockResolvedValue("actor-123");

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);

  const replyTool = pi._registeredTools.find((t: any) => t.name === "cccc_reply");
  const result = await replyTool.execute(
    "call-1",
    { text: "thanks", eventId: "evt-original" },
    undefined,
    undefined,
    {},
  );

  expect(mockReply).toHaveBeenCalledWith({
    groupId: "test-group",
    replyTo: "evt-original",
    text: "thanks",
  });
  expect(result.content[0].text).toContain("Reply sent");
  expect(result.details.eventId).toBe("reply-evt-1");
});

test("cccc_send returns error when group not connected", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: ["test-group"],
    actorId: null,
    pollIntervalMs: 3000,
  });
  mockEnsureRegistered.mockResolvedValue("actor-123");

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);

  const sendTool = pi._registeredTools.find((t: any) => t.name === "cccc_send");
  const result = await sendTool.execute(
    "call-1",
    { text: "hello", groupId: "nonexistent-group" },
    undefined,
    undefined,
    {},
  );

  expect(result.content[0].text).toContain("Error");
  expect(mockSend).not.toHaveBeenCalled();
});

test("cccc_reply returns error when group not connected", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: ["test-group"],
    actorId: null,
    pollIntervalMs: 3000,
  });
  mockEnsureRegistered.mockResolvedValue("actor-123");

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);

  const replyTool = pi._registeredTools.find((t: any) => t.name === "cccc_reply");
  const result = await replyTool.execute(
    "call-1",
    { text: "thanks", eventId: "evt-1", groupId: "nonexistent-group" },
    undefined,
    undefined,
    {},
  );

  expect(result.content[0].text).toContain("Error");
  expect(mockReply).not.toHaveBeenCalled();
});

test("tools registered in sub-agent sessions", async () => {
  process.env["CCCC_PARENT_ACTOR_test-group"] = "parent-actor-123";
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: ["test-group"],
    actorId: null,
    pollIntervalMs: 3000,
  });

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);

  expect(pi.registerTool).toHaveBeenCalled();
  const toolNames = pi._registeredTools.map((t: any) => t.name);
  expect(toolNames).toContain("cccc_send");
  expect(toolNames).toContain("cccc_reply");
});
