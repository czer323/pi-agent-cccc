import { vi, expect, test, beforeEach } from "vite-plus/test";
import mod from "../src/index.ts";

// ---------- hoisted mock fns (shared between vi.mock factories and tests) ----------

const {
  mockLoadConfig,
  mockConnect,
  mockDisconnect,
  mockEnsureRegistered,
  mockStreamerStart,
  mockStreamerStop,
  mockPollerStart,
  mockPollerStop,
} = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockConnect: vi.fn().mockResolvedValue(undefined),
  mockDisconnect: vi.fn(),
  mockEnsureRegistered: vi.fn(),
  mockStreamerStart: vi.fn(),
  mockStreamerStop: vi.fn(),
  mockPollerStart: vi.fn(),
  mockPollerStop: vi.fn(),
}));

// ---------- module mocks ----------

vi.mock("../src/config.ts", () => ({
  loadConfig: mockLoadConfig,
}));

vi.mock("../src/client.ts", () => ({
  // Must use a regular function (not arrow) so it works with `new CCCCBridgeClient()`
  CCCCBridgeClient: vi.fn(function () {
    return { connect: mockConnect, disconnect: mockDisconnect };
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

// ---------- helpers ----------

beforeEach(() => {
  vi.resetAllMocks();
  mockConnect.mockResolvedValue(undefined);
});

function createMockPi() {
  const handlers = new Map<string, Function>();
  const notify = vi.fn();
  const setStatus = vi.fn();
  const pi: Record<string, unknown> = {
    on: vi.fn((event: string, handler: Function) => {
      handlers.set(event, handler);
    }),
    _handlers: handlers,
    _notify: notify,
    _setStatus: setStatus,
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

test("session_shutdown stops streamer and disconnects client for single group", async () => {
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

  expect(mockStreamerStop).toHaveBeenCalledTimes(2);
  expect(mockDisconnect).toHaveBeenCalledTimes(2);
});

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
