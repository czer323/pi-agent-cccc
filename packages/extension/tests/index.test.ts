import { vi, expect, test, beforeEach } from "vite-plus/test";
import mod from "../src/index.ts";

// ---------- hoisted mock fns (shared between vi.mock factories and tests) ----------

const {
  mockLoadConfig,
  mockConnect,
  mockDisconnect,
  mockEnsureRegistered,
  mockPollerStart,
  mockPollerStop,
} = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockConnect: vi.fn().mockResolvedValue(undefined),
  mockDisconnect: vi.fn(),
  mockEnsureRegistered: vi.fn(),
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

test("inert when CCCC_GROUP_ID is empty", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groupId: "",
    actorId: null,
    pollIntervalMs: 3000,
  });

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);

  expect(mockConnect).not.toHaveBeenCalled();
  expect(mockEnsureRegistered).not.toHaveBeenCalled();
  expect(mockPollerStart).not.toHaveBeenCalled();
});

test("successful startup connects, registers, starts polling", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groupId: "test-group",
    actorId: null,
    pollIntervalMs: 3000,
  });
  mockEnsureRegistered.mockResolvedValue("actor-123");

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);

  expect(mockConnect).toHaveBeenCalledTimes(1);
  expect(mockEnsureRegistered).toHaveBeenCalledTimes(1);
  expect(mockPollerStart).toHaveBeenCalledTimes(1);
});

test("connection failure degrades gracefully", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groupId: "test-group",
    actorId: null,
    pollIntervalMs: 3000,
  });
  mockConnect.mockRejectedValue(new Error("ECONNREFUSED"));

  const pi = createMockPi();
  mod(pi);
  await expect(triggerSessionStart(pi)).resolves.toBeUndefined();

  expect(mockConnect).toHaveBeenCalledTimes(1);
  expect(mockEnsureRegistered).not.toHaveBeenCalled();
  expect(mockPollerStart).not.toHaveBeenCalled();
});

test("session_shutdown stops poller and disconnects client", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groupId: "test-group",
    actorId: null,
    pollIntervalMs: 3000,
  });
  mockEnsureRegistered.mockResolvedValue("actor-123");

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi);
  expect(mockPollerStart).toHaveBeenCalledTimes(1);

  await triggerSessionShutdown(pi);

  expect(mockPollerStop).toHaveBeenCalledTimes(1);
  expect(mockDisconnect).toHaveBeenCalledTimes(1);
});

test("UI calls are guarded by ctx.hasUI", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groupId: "test-group",
    actorId: null,
    pollIntervalMs: 3000,
  });
  mockEnsureRegistered.mockResolvedValue("actor-123");

  const pi = createMockPi();
  mod(pi);

  // When hasUI is true, setStatus and notify should be called with success
  await triggerSessionStart(pi, true);
  expect(pi._setStatus).toHaveBeenCalledWith("cccc", "connected");
  expect(pi._notify).toHaveBeenCalledWith("CCCC bridge connected", "info");
});

test("UI calls notify on connection failure when hasUI is true", async () => {
  mockLoadConfig.mockReturnValue({
    daemonHost: "localhost",
    daemonPort: 9765,
    groupId: "test-group",
    actorId: null,
    pollIntervalMs: 3000,
  });
  mockConnect.mockRejectedValue(new Error("ECONNREFUSED"));

  const pi = createMockPi();
  mod(pi);
  await triggerSessionStart(pi, true);

  expect(pi._notify).toHaveBeenCalled();
  expect(pi._setStatus).toHaveBeenCalledWith("cccc", "disconnected");
});
