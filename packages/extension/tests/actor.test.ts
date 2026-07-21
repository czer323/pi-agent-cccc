// oxlint-disable typescript/unbound-method
import { expect, test, vi, describe, beforeEach } from "vite-plus/test";
import { getActorId, generateActorId, ensureRegistered } from "../src/actor.ts";
import type { BridgeConfig } from "../src/config.ts";
import type { CCCCBridgeClient } from "../src/client.ts";
import { BridgeClientError } from "../src/types.ts";

const baseConfig: BridgeConfig = {
  daemonHost: "192.168.7.163",
  daemonPort: 9765,
  groups: ["test-group"],
  actorId: null,
  pollIntervalMs: 3000,
  autoDiscover: false,
  defaultGroupId: null,
};

function mockClient() {
  return { registerActor: vi.fn() } as unknown as CCCCBridgeClient;
}

// ---- generateActorId ----

describe("generateActorId", () => {
  test("produces expected format with explicit params", () => {
    const id = generateActorId({ role: "pi", machine: "truenas", project: "pi-agent-cccc" });
    expect(id).toMatch(/^pi-truenas-pi-agent-cccc-[a-z0-9]{6}$/);
  });

  test("includes random suffix for uniqueness", () => {
    const id1 = generateActorId({ role: "pi", machine: "m1", project: "proj" });
    const id2 = generateActorId({ role: "pi", machine: "m1", project: "proj" });
    expect(id1).not.toBe(id2);
  });

  test("defaults role to pi and uses real hostname/project", () => {
    const id = generateActorId();
    expect(id).toMatch(/^pi-/);
    // Should have at least three hyphens: role-machine-project-random
    expect(id.split("-").length).toBeGreaterThanOrEqual(4);
  });
});

// ---- getActorId ----

describe("getActorId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("returns env override when set", () => {
    const config = { ...baseConfig, actorId: "override-actor" };
    const id = getActorId(config);
    expect(id).toBe("override-actor");
  });

  test("auto-generates with random suffix when no override", () => {
    const id = getActorId(baseConfig);
    expect(id).toMatch(/^pi-/);
    // Should include random suffix
    expect(id.split("-").length).toBeGreaterThanOrEqual(4);
  });
});

// ---- ensureRegistered ----

describe("ensureRegistered", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("calls registerActor with correct params", async () => {
    const client = mockClient();
    const config = { ...baseConfig } as BridgeConfig;
    vi.mocked(client.registerActor).mockResolvedValue({ actorId: "generated-actor-id" });

    const result = await ensureRegistered(client, config, "test-group");

    expect(result).toMatch(/^pi-/);
    expect(client.registerActor).toHaveBeenCalledWith({
      groupId: "test-group",
      actorId: expect.stringMatching(/^pi-/),
      runtime: "custom",
      runner: "headless",
      title: "Pi Agent",
    });
  });

  test("re-throws registration errors", async () => {
    const client = mockClient();
    const config = { ...baseConfig } as BridgeConfig;
    const error = new BridgeClientError("registerActor failed", new Error("network error"));
    vi.mocked(client.registerActor).mockRejectedValue(error);

    await expect(ensureRegistered(client, config, "test-group")).rejects.toThrow(BridgeClientError);
  });
});
