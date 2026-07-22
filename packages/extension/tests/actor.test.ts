// oxlint-disable typescript/unbound-method
import { expect, test, vi, describe, beforeEach } from "vite-plus/test";
import { getActorId, generateActorId, buildActorId, ensureRegistered } from "../src/actor.ts";
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
  agentTitle: "Pi Agent",
  subAgentTitle: "Pi Sub-Agent",
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

describe("buildActorId", () => {
  test("returns ID unchanged when under 32 chars", () => {
    const id = buildActorId("pi", "m1", "proj", "abc123");
    expect(id).toBe("pi-m1-proj-abc123");
    expect(id.length).toBeLessThanOrEqual(32);
  });

  test("truncates long project name to fit 32 chars", () => {
    const id = buildActorId("pi", "ubuntu", "pi-agent-cccc-test-long", "abc123");
    expect(id.length).toBeLessThanOrEqual(32);
    // Should end with the suffix
    expect(id).toMatch(/-abc123$/);
    // Should start with role-machine
    expect(id).toMatch(/^pi-ubuntu-/);
  });

  test("preserves suffix when truncating", () => {
    const suffix = "xyz789";
    const id = buildActorId(
      "pi",
      "truenas",
      "this-is-a-very-long-project-name-that-exceeds-limit",
      suffix,
    );
    expect(id).toMatch(new RegExp(`${suffix}$`));
    expect(id.length).toBeLessThanOrEqual(32);
  });

  test("handles exactly 32 char boundary", () => {
    const id = buildActorId("pi", "truenas", "pi-agent-cccc", "abc123");
    expect(id).toBe("pi-truenas-pi-agent-cccc-abc123");
    expect(id.length).toBe(31);
  });

  test("minimum project length of 1 when heavily constrained", () => {
    const id = buildActorId("role-mach", "x", "project", "suffix");
    expect(id.length).toBeLessThanOrEqual(32);
    // Should still have at least 1 char of project
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

test("handles 'Name already exists' gracefully when actor is still registered", async () => {
  const client = mockClient();
  const config = { ...baseConfig } as BridgeConfig;
  const conflictError = new BridgeClientError(
    "registerActor failed",
    new Error("conflict: Name already exists"),
  );
  vi.mocked(client.registerActor).mockRejectedValue(conflictError);

  const result = await ensureRegistered(client, config, "test-group");

  expect(result).toMatch(/^pi-/);
  expect(client.registerActor).toHaveBeenCalledTimes(1);
});

describe("ensureRegistered title", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('uses default title "Pi Agent" when no title provided', async () => {
    const client = mockClient();
    const config = { ...baseConfig } as BridgeConfig;
    vi.mocked(client.registerActor).mockResolvedValue({ actorId: "generated-actor-id" });

    await ensureRegistered(client, config, "test-group");

    expect(client.registerActor).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Pi Agent" }),
    );
  });

  test("passes custom title when provided via options", async () => {
    const client = mockClient();
    const config = { ...baseConfig } as BridgeConfig;
    vi.mocked(client.registerActor).mockResolvedValue({ actorId: "generated-actor-id" });

    await ensureRegistered(client, config, "test-group", { title: "My Agent" });

    expect(client.registerActor).toHaveBeenCalledWith(
      expect.objectContaining({ title: "My Agent" }),
    );
  });
});
