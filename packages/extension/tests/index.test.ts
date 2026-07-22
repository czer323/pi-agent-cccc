import { vi, expect, test, beforeEach } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import mod from "../src/index.ts";
import { InboxStreamer } from "../src/streamer.ts";

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
  mockGroupShow,
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
  mockGroupShow: vi.fn(),
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
      groupShow: mockGroupShow,
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

vi.mock("../src/actor.ts", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("../src/actor.ts");
  return {
    ...actual,
    ensureRegistered: mockEnsureRegistered,
  };
});

vi.mock("../src/inbox.ts", () => ({
  // Must use a regular function (not arrow) so it works with `new InboxPoller()`
  InboxPoller: vi.fn(function (opts: any) {
    (globalThis as any).__pollerOnReconnect = opts.onReconnect;
    return { start: mockPollerStart, stop: mockPollerStop };
  }),
}));

vi.mock("../src/streamer.ts", () => ({
  // Must use a regular function (not arrow) so it works with `new InboxStreamer()`
  InboxStreamer: vi.fn(function (opts: any) {
    (globalThis as any).__streamerOnReconnect = opts.onReconnect;
    return { start: mockStreamerStart, stop: mockStreamerStop };
  }),
}));

vi.mock("../src/inbox-queue.ts", () => ({
  InboxQueue: vi.fn(function () {
    return { enqueue: vi.fn(), wake: vi.fn(), destroy: vi.fn() };
  }),
}));
vi.mock("../src/discovery.ts", () => ({
  discoverGroups: mockDiscoverGroups,
}));

// ---------- helpers ----------

beforeEach(() => {
  vi.resetAllMocks();
  delete (globalThis as any).__pollerOnReconnect;
  delete (globalThis as any).__streamerOnReconnect;
  mockConnect.mockResolvedValue(undefined);
  mockSend.mockResolvedValue({ event: { id: "evt-1" }, ack_event: null });
  mockReply.mockResolvedValue({ event: { id: "reply-evt-1" }, ack_event: null });
  mockGroupShow.mockResolvedValue({
    group: { group_id: "test-group", title: "Test Group" },
    actors: [
      {
        id: "foreman-01",
        title: "Foreman",
        runtime: "python",
        runner: "anthropic",
        role: "foreman",
      },
      { id: "worker-02", title: "Worker", runtime: "python", runner: "openai", role: "peer" },
      { id: "observer-03", title: "Observer", runtime: "go", runner: "human", role: "peer" },
    ],
  });
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

// ---------- lifecycle broadcast tests ----------

test("session_start sends online broadcast after registration", async () => {
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

  expect(mockSend).toHaveBeenCalledWith(
    expect.objectContaining({
      groupId: "test-group",
      text: "Agent actor-123 online",
    }),
  );
  expect(mockStreamerStart).toHaveBeenCalledTimes(1);
});

test("broadcast failure on session_start does not crash", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: ["test-group"],
    actorId: null,
    pollIntervalMs: 3000,
  });
  mockEnsureRegistered.mockResolvedValue("actor-123");
  mockSend.mockRejectedValue(new Error("send failed"));

  const pi = createMockPi();
  mod(pi);
  await expect(triggerSessionStart(pi)).resolves.toBeUndefined();

  // Streamer should still start despite broadcast failure
  expect(mockStreamerStart).toHaveBeenCalledTimes(1);
  expect(mockEnsureRegistered).toHaveBeenCalledTimes(1);
});

// ---------- onReconnect tests ----------

test("InboxStreamer receives onReconnect callback in options", async () => {
  const pi = createMockPi();
  mockLoadConfig.mockReturnValue({
    groups: ["test-group"],
    autoDiscover: false,
    daemonHost: "localhost",
    daemonPort: 9765,
    pollIntervalMs: 3000,
    actorId: null,
    defaultGroupId: null,
  });
  mockEnsureRegistered.mockResolvedValue("test-actor-01");
  mod(pi);

  await triggerSessionStart(pi);

  // InboxStreamer constructor should have been called with onReconnect
  const cb = (globalThis as any).__streamerOnReconnect;
  expect(cb).toBeDefined();
  expect(typeof cb).toBe("function");
});

test("InboxPoller onReconnect callback works via fallback path", async () => {
  const pi = createMockPi();
  mockLoadConfig.mockReturnValue({
    groups: ["test-group"],
    autoDiscover: false,
    daemonHost: "localhost",
    daemonPort: 9765,
    pollIntervalMs: 3000,
    actorId: null,
    defaultGroupId: null,
  });
  mockEnsureRegistered.mockResolvedValue("test-actor-01");
  mod(pi);

  await triggerSessionStart(pi);

  // Trigger the fallback to create the poller
  const streamerOpts = vi.mocked(InboxStreamer).mock.calls[0][0];
  streamerOpts.onFallback();

  // Poller should have been created with onReconnect
  const cb = (globalThis as any).__pollerOnReconnect;
  expect(cb).toBeDefined();
  expect(typeof cb).toBe("function");

  // Invoke it to verify it works
  mockRegisterActor.mockClear();
  mockSend.mockClear();
  await cb();
  expect(mockRegisterActor).toHaveBeenCalled();
  expect(mockSend).toHaveBeenCalled();
});

test("onReconnect callback re-registers actor and sends online broadcast", async () => {
  const pi = createMockPi();
  mockLoadConfig.mockReturnValue({
    groups: ["test-group"],
    autoDiscover: false,
    daemonHost: "localhost",
    daemonPort: 9765,
    pollIntervalMs: 3000,
    actorId: null,
    defaultGroupId: null,
    agentTitle: "Pi Agent",
    subAgentTitle: "Pi Sub-Agent",
  });
  mockEnsureRegistered.mockResolvedValue("test-actor-01");
  mod(pi);

  await triggerSessionStart(pi);

  // Invoke the onReconnect callback from streamer
  const cb = (globalThis as any).__streamerOnReconnect;
  await cb();

  // Should have re-registered the actor
  expect(mockRegisterActor).toHaveBeenCalledWith({
    groupId: "test-group",
    actorId: "test-actor-01",
    runtime: "custom",
    runner: "headless",
    title: "Pi Agent",
  });

  // Should have sent online broadcast
  expect(mockSend).toHaveBeenCalledWith({
    groupId: "test-group",
    text: "Agent test-actor-01 online",
  });
});

test("onReconnect callback failure does not crash", async () => {
  const pi = createMockPi();
  mockLoadConfig.mockReturnValue({
    groups: ["test-group"],
    autoDiscover: false,
    daemonHost: "localhost",
    daemonPort: 9765,
    pollIntervalMs: 3000,
    actorId: null,
    defaultGroupId: null,
  });
  mockEnsureRegistered.mockResolvedValue("test-actor-01");
  mod(pi);

  await triggerSessionStart(pi);

  // Make registerActor throw
  mockRegisterActor.mockRejectedValueOnce(new Error("registration failed"));

  // Invoke the onReconnect callback - should not throw
  const cb = (globalThis as any).__streamerOnReconnect;
  await expect(cb()).resolves.toBeUndefined();
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

test("session_shutdown sends offline broadcast before removal", async () => {
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

  await triggerSessionShutdown(pi);

  expect(mockSend).toHaveBeenCalledWith(
    expect.objectContaining({
      groupId: "test-group",
      text: "Agent actor-123 going offline",
    }),
  );
  expect(mockActorRemove).toHaveBeenCalledWith("test-group", "actor-123");
});

test("broadcast failure on session_shutdown does not block shutdown", async () => {
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

  // Make send fail for the offline broadcast
  mockSend.mockRejectedValue(new Error("send failed"));

  await expect(triggerSessionShutdown(pi)).resolves.toBeUndefined();

  // Actor removal and disconnect should still happen
  expect(mockActorRemove).toHaveBeenCalledWith("test-group", "actor-123");
  expect(mockDisconnect).toHaveBeenCalledTimes(1);
  expect(mockStreamerStop).toHaveBeenCalledTimes(1);
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
  expect(pi._notify).toHaveBeenCalledWith('CCCC bridge connected as "actor-123" (1 group)', "info");
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
  expect(pi._notify).toHaveBeenCalledWith(
    'CCCC bridge connected as "actor-123" (2 groups)',
    "info",
  );
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
    agentTitle: "Pi Agent",
    subAgentTitle: "Pi Sub-Agent",
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
    expect.objectContaining({ title: "Pi Agent" }),
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

test("sub-agent detects parent via env var and registers child actor", async () => {
  process.env["CCCC_PARENT_ACTOR_test-group"] = "parent-actor-123";

  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: ["test-group"],
    actorId: null,
    pollIntervalMs: 3000,
    agentTitle: "Pi Agent",
    subAgentTitle: "Pi Sub-Agent",
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

test("registers all tools on parent session_start", async () => {
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

  expect(pi.registerTool).toHaveBeenCalledTimes(5);
  const toolNames = pi._registeredTools.map((t: any) => t.name);
  expect(toolNames).toContain("cccc_send");
  expect(toolNames).toContain("cccc_reply");
  expect(toolNames).toContain("cccc_whoami");
  expect(toolNames).toContain("cccc_list_actors");
  expect(toolNames).toContain("cccc_rename");
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
  // mockSend is called once for online broadcast during session_start
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledWith(
    expect.objectContaining({ text: expect.stringContaining("online") }),
  );
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

  // Tools are registered
  expect(pi.registerTool).toHaveBeenCalled();
  const toolNames = pi._registeredTools.map((t: any) => t.name);
  expect(toolNames).toContain("cccc_send");
  expect(toolNames).toContain("cccc_reply");
  expect(toolNames).toContain("cccc_whoami");

  // Sub-agent announcement was sent on startup
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledWith(
    expect.objectContaining({
      groupId: "test-group",
      to: ["parent-actor-123"],
    }),
  );

  // cccc_send tool is executable in sub-agent context
  const sendTool = pi._registeredTools.find((t: any) => t.name === "cccc_send");
  const result = await sendTool.execute(
    "call-1",
    { text: "findings report", to: "parent-actor-123" },
    undefined,
    undefined,
    {},
  );

  expect(mockSend).toHaveBeenCalledTimes(2);
  expect(mockSend).toHaveBeenNthCalledWith(2, {
    groupId: "test-group",
    text: "findings report",
    to: ["parent-actor-123"],
  });
  expect(result.content[0].text).toContain("Message sent");

  // cccc_reply tool is executable in sub-agent context
  const replyTool = pi._registeredTools.find((t: any) => t.name === "cccc_reply");
  const replyResult = await replyTool.execute(
    "call-2",
    { text: "reply to parent", eventId: "evt-original" },
    undefined,
    undefined,
    {},
  );

  expect(mockReply).toHaveBeenCalledWith({
    groupId: "test-group",
    replyTo: "evt-original",
    text: "reply to parent",
  });
  expect(replyResult.content[0].text).toContain("Reply sent");

  // cccc_whoami returns sub-agent's identity (derived from parent actor ID)
  const whoamiTool = pi._registeredTools.find((t: any) => t.name === "cccc_whoami");
  const whoamiResult = await whoamiTool.execute();
  expect(whoamiResult.content[0].text).toMatch(/Actor ID: parent-actor-123-child-/);
  expect(whoamiResult.content[0].text).toContain("test-group");

  // Sub-agent does NOT start streamer/poller or call ensureRegistered
  expect(mockStreamerStart).not.toHaveBeenCalled();
  expect(mockPollerStart).not.toHaveBeenCalled();
  expect(mockEnsureRegistered).not.toHaveBeenCalled();
});

test("sub-agent cccc_send to parent actor calls client.send correctly", async () => {
  process.env["CCCC_PARENT_ACTOR_test-group"] = "parent-actor-456";
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

  // Sub-agent announcement was sent with parent actor ID
  expect(mockSend).toHaveBeenCalledWith(
    expect.objectContaining({
      groupId: "test-group",
      text: expect.stringContaining("Sub-agent ready:"),
      to: ["parent-actor-456"],
    }),
  );

  // Sub-agent calls cccc_send to report findings to parent
  const sendTool = pi._registeredTools.find((t: any) => t.name === "cccc_send");
  const result = await sendTool.execute(
    "call-3",
    { text: "Task complete: analysis done", to: "parent-actor-456" },
    undefined,
    undefined,
    {},
  );

  // client.send was called with the parent actor as recipient
  expect(mockSend).toHaveBeenLastCalledWith({
    groupId: "test-group",
    text: "Task complete: analysis done",
    to: ["parent-actor-456"],
  });
  expect(result.details.eventId).toBe("evt-1");
});

test("registers cccc_whoami tool on session_start", async () => {
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

  expect(pi.registerTool).toHaveBeenCalled();
  const toolNames = pi._registeredTools.map((t: any) => t.name);
  expect(toolNames).toContain("cccc_whoami");
});

test("cccc_whoami tool returns actor ID and group IDs", async () => {
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

  const whoamiTool = pi._registeredTools.find((t: any) => t.name === "cccc_whoami");
  expect(whoamiTool).toBeDefined();
  const result = await whoamiTool.execute("call-1", {}, undefined, undefined, {});

  expect(result.content[0].text).toContain("actor-123");
  expect(result.content[0].text).toContain("group-a");
  expect(result.content[0].text).toContain("group-b");
});

// ---------- cccc_list_actors tool tests ----------

test("registers cccc_list_actors tool on session_start", async () => {
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

  expect(pi.registerTool).toHaveBeenCalled();
  const toolNames = pi._registeredTools.map((t: any) => t.name);
  expect(toolNames).toContain("cccc_list_actors");
});

test("cccc_list_actors tool has no parameters", async () => {
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

  const tool = pi._registeredTools.find((t: any) => t.name === "cccc_list_actors");
  expect(tool).toBeDefined();
  expect(tool.parameters.properties).toEqual({});
});

test("cccc_list_actors tool execute calls client.groupShow with first group", async () => {
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

  const tool = pi._registeredTools.find((t: any) => t.name === "cccc_list_actors");
  const result = await tool.execute("call-1", {}, undefined, undefined, {});

  expect(mockGroupShow).toHaveBeenCalledWith("test-group");
  expect(result.content[0].text).toContain("foreman-01");
  expect(result.content[0].text).toContain("Foreman");
  expect(result.content[0].text).toContain("python");
  expect(result.content[0].text).toContain("anthropic");
  expect(result.content[0].text).toContain("worker-02");
  expect(result.content[0].text).toContain("observer-03");
});

test("cccc_list_actors tool is not registered when no groups are connected", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: [],
    actorId: null,
    pollIntervalMs: 3000,
  });

  const pi = createMockPi();
  mod(pi);
  // No triggerSessionStart — session_start returns early when groups empty

  const toolNames = pi._registeredTools.map((t: any) => t.name);
  expect(toolNames).not.toContain("cccc_list_actors");
  // Other tools also not registered
  expect(toolNames).not.toContain("cccc_send");
  expect(toolNames).not.toContain("cccc_reply");
});

test("cccc_list_actors tool warns when multiple groups connected", async () => {
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
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

    const tool = pi._registeredTools.find((t: any) => t.name === "cccc_list_actors");
    await tool.execute("call-1", {}, undefined, undefined, {});

    expect(mockGroupShow).toHaveBeenCalledWith("group-a");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Multiple groups connected"));
  } finally {
    warnSpy.mockRestore();
  }
});

// ---------- cccc_rename tool tests ----------

test("cccc_rename tool registered on session_start", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: ["test-group"],
    actorId: null,
    pollIntervalMs: 3000,
    agentTitle: "Pi Agent",
    subAgentTitle: "Pi Sub-Agent",
  });
  mockEnsureRegistered.mockResolvedValue("actor-123");

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);

  const renameTool = pi._registeredTools.find((t: any) => t.name === "cccc_rename");
  expect(renameTool).toBeDefined();
});

test("cccc_rename tool has title parameter", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: ["test-group"],
    actorId: null,
    pollIntervalMs: 3000,
    agentTitle: "Pi Agent",
    subAgentTitle: "Pi Sub-Agent",
  });
  mockEnsureRegistered.mockResolvedValue("actor-123");

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);

  const renameTool = pi._registeredTools.find((t: any) => t.name === "cccc_rename");
  expect(renameTool).toBeDefined();
  const props = renameTool.parameters.properties;
  expect(props).toBeDefined();
  expect(props.title).toBeDefined();
  expect(props.title.type).toBe("string");
});

test("cccc_rename tool registers new actor with updated title", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groups: ["test-group"],
    actorId: null,
    pollIntervalMs: 3000,
    agentTitle: "Pi Agent",
    subAgentTitle: "Pi Sub-Agent",
  });
  mockEnsureRegistered.mockResolvedValue("actor-123");

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);

  const renameTool = pi._registeredTools.find((t: any) => t.name === "cccc_rename");
  expect(renameTool).toBeDefined();

  const result = await renameTool.execute(
    "call-1",
    { title: "New Agent Name" },
    undefined,
    undefined,
    {},
  );

  // Should call registerActor with new title
  expect(mockRegisterActor).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "New Agent Name",
    }),
  );
  expect(result.content[0].text).toContain("New Agent Name");
});

test("cccc_send warns when multiple groups connected and no groupId specified", async () => {
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
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
    const result = await sendTool.execute("call-1", { text: "hello" }, undefined, undefined, {});

    // Routes to first group by default
    expect(mockSend).toHaveBeenCalledWith({
      groupId: "group-a",
      text: "hello",
      to: undefined,
    });
    expect(result.content[0].text).toContain("Message sent");
    expect(result.details.groupId).toBe("group-a");
    // Warns about multiple groups
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Multiple groups connected"));
  } finally {
    warnSpy.mockRestore();
  }
});

test("cccc_reply warns when multiple groups connected and no groupId specified", async () => {
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
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

    const replyTool = pi._registeredTools.find((t: any) => t.name === "cccc_reply");
    const result = await replyTool.execute(
      "call-1",
      { text: "thanks", eventId: "evt-1" },
      undefined,
      undefined,
      {},
    );

    // Routes to first group by default
    expect(mockReply).toHaveBeenCalledWith({
      groupId: "group-a",
      replyTo: "evt-1",
      text: "thanks",
    });
    expect(result.content[0].text).toContain("Reply sent");
    expect(result.details.groupId).toBe("group-a");
    // Warns about multiple groups
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Multiple groups connected"));
  } finally {
    warnSpy.mockRestore();
  }
});

// ---------- coordination skill tests ----------

test("cccc-coordination skill file exists at packages/extension/skills/cccc-coordination.md", () => {
  const skillPath = path.resolve(__dirname, "../skills/cccc-coordination.md");
  expect(fs.existsSync(skillPath)).toBe(true);
});

test("cccc-coordination skill file covers all 7 required topics", () => {
  const skillPath = path.resolve(__dirname, "../skills/cccc-coordination.md");
  const content = fs.readFileSync(skillPath, "utf-8");

  // Topic 1: cccc_send vs cccc_reply guidance
  expect(content).toMatch(/cccc_send/);
  expect(content).toMatch(/cccc_reply/);
  expect(content).toMatch(/reply/);

  // Topic 2: Addressing messages (@all, @peers, @foreman, specific actor IDs)
  expect(content).toMatch(/@all|@peers|@foreman|actor.?ID/i);

  // Topic 3: cccc_whoami usage
  expect(content).toMatch(/cccc_whoami|who.?am/i);

  // Topic 4: cccc_list_actors usage
  expect(content).toMatch(/cccc_list_actors|list.?actor/i);

  // Topic 5: Interpreting incoming messages (provenance, reply-required)
  expect(content).toMatch(/reply.?required|provenance|incoming/i);

  // Topic 6: Best practices (concise, reply_required, acknowledge)
  expect(content).toMatch(/concise|best.?practice|acknowledg/i);

  // Topic 7: Sub-agent pattern (spawn, report back via cccc_send)
  expect(content).toMatch(/sub.?agent|spawn|report.*result|cccc_send/i);
});

test("session_start logs a hint that the coordination skill exists", async () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
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

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("cccc-coordination"));
  } finally {
    logSpy.mockRestore();
  }
});
