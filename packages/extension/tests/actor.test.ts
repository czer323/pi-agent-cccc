// oxlint-disable typescript/unbound-method
import { expect, test, vi, describe, beforeEach } from "vite-plus/test";
import { readFileSync, writeFileSync } from "node:fs";
import { getActorId, generateActorId, ensureRegistered } from "../src/actor.ts";
import type { BridgeConfig } from "../src/config.ts";
import type { CCCCBridgeClient } from "../src/client.ts";
import { BridgeClientError } from "../src/types.ts";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

const baseConfig: BridgeConfig = {
  daemonHost: "192.168.7.163",
  daemonPort: 9765,
  groups: ["test-group"],
  actorId: null,
  pollIntervalMs: 3000,
  autoDiscover: false,
  defaultGroupId: null,
};

const testStatePath = "/tmp/test-cccc-state.json";

function mockClient() {
  return { registerActor: vi.fn() } as unknown as CCCCBridgeClient;
}

// ---- generateActorId ----

describe("generateActorId", () => {
  test("produces expected format with explicit params", () => {
    const id = generateActorId({ role: "pi", machine: "truenas", project: "pi-agent-cccc" });
    expect(id).toBe("pi-truenas-pi-agent-cccc");
  });

  test("defaults role to pi and uses real hostname/project", () => {
    const id = generateActorId();
    expect(id).toMatch(/^pi-/);
    // Should have at least two hyphens: role-machine-project
    expect(id.split("-").length).toBeGreaterThanOrEqual(3);
  });
});

// ---- getActorId ----

describe("getActorId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("returns env override when set", () => {
    const config = { ...baseConfig, actorId: "override-actor" };
    const id = getActorId(config, testStatePath);
    expect(id).toBe("override-actor");
    expect(readFileSync).not.toHaveBeenCalled();
  });

  test("returns cached value from state file", () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ actor_id: "cached-actor-abc123", registered_at: "2026-01-01T00:00:00Z" }),
    );
    const id = getActorId(baseConfig, testStatePath);
    expect(id).toBe("cached-actor-abc123");
    expect(readFileSync).toHaveBeenCalledWith(testStatePath, "utf-8");
  });

  test("auto-generates when no override and no cache", () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const id = getActorId(baseConfig, testStatePath);
    expect(id).toMatch(/^pi-/);
    expect(readFileSync).toHaveBeenCalledWith(testStatePath, "utf-8");
  });
});

// ---- ensureRegistered ----

describe("ensureRegistered", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("calls registerActor with correct params", async () => {
    const client = mockClient();
    const config = { ...baseConfig, actorId: "test-actor-id" } as BridgeConfig;
    vi.mocked(client.registerActor).mockResolvedValue({ actorId: "test-actor-id" });

    const result = await ensureRegistered(client, config, "test-group", testStatePath);

    expect(result).toBe("test-actor-id");
    expect(client.registerActor).toHaveBeenCalledWith({
      groupId: "test-group",
      actorId: "test-actor-id",
      runtime: "custom",
      runner: "headless",
      title: "Pi Agent",
    });
  });

  test("writes state file on first registration", async () => {
    const client = mockClient();
    const config = { ...baseConfig, actorId: "test-actor-id" } as BridgeConfig;
    vi.mocked(client.registerActor).mockResolvedValue({ actorId: "test-actor-id" });

    await ensureRegistered(client, config, "test-group", testStatePath);

    expect(writeFileSync).toHaveBeenCalledWith(
      testStatePath,
      expect.stringContaining("test-actor-id"),
      "utf-8",
    );
  });

  test("is idempotent when actor already exists", async () => {
    const client = mockClient();
    const config = { ...baseConfig, actorId: "existing-actor" } as BridgeConfig;
    const existsError = new BridgeClientError(
      "registerActor failed",
      new Error("actor already exists"),
    );
    vi.mocked(client.registerActor).mockRejectedValue(existsError);

    const result = await ensureRegistered(client, config, "test-group", testStatePath);

    expect(result).toBe("existing-actor");
    // State file should NOT be written on idempotent re-registration
    expect(writeFileSync).not.toHaveBeenCalled();
  });
  test("is idempotent with actual daemon error message", async () => {
    const client = mockClient();
    const config = { ...baseConfig, actorId: "existing-actor-2" } as BridgeConfig;
    // The CCCC daemon sends "Name already exists: <actor_id>" when re-registering
    const existsError = new BridgeClientError(
      "registerActor failed",
      new Error("Name already exists: existing-actor-2"),
    );
    vi.mocked(client.registerActor).mockRejectedValue(existsError);

    const result = await ensureRegistered(client, config, "test-group", testStatePath);

    expect(result).toBe("existing-actor-2");
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  test("re-throws non-actor-exists errors", async () => {
    const client = mockClient();
    const config = { ...baseConfig, actorId: "test-actor-id" } as BridgeConfig;
    const otherError = new BridgeClientError("registerActor failed", new Error("network error"));
    vi.mocked(client.registerActor).mockRejectedValue(otherError);

    await expect(ensureRegistered(client, config, "test-group", testStatePath)).rejects.toThrow(
      BridgeClientError,
    );
  });
});
