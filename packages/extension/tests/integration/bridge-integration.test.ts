// oxlint-disable typescript/unbound-method
/**
 * Layer 2: Integration tests for the CCCC bridge extension.
 *
 * These tests run against a LIVE CCCC daemon and are excluded from the
 * default `vp test` run. Run them explicitly with:
 *   vp test tests/integration/
 *
 * Prerequisites:
 *   - CCCC_DAEMON_HOST (required) — daemon TCP host
 *   - CCCC_DAEMON_PORT (optional, default 9765) — daemon TCP port
 *   - CCCC_GROUP_ID (optional) — target group; auto-discovers first group if absent
 *   - cccc CLI on PATH (for the send step)
 *
 * All tests are skipped gracefully when CCCC_DAEMON_HOST is not set.
 */

import { expect, test, describe, beforeAll, afterAll } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { CCCCBridgeClient, defaultBridgeConfig } from "../../src/client.ts";
import type { BridgeClientConfig } from "../../src/types.ts";

// ---- env guard ----

const DAEMON_HOST = process.env.CCCC_DAEMON_HOST;
const DAEMON_PORT = Number.parseInt(process.env.CCCC_DAEMON_PORT ?? "9765", 10);
const GROUP_ID = process.env.CCCC_GROUP_ID;
const hasDaemon = !!DAEMON_HOST;

const testRunId = randomUUID().split("-")[0];
const TEST_ACTOR_ID = `test-int-${testRunId}`;
const TEST_MESSAGE_TEXT = `Integration test message ${testRunId}`;

// ---- helpers ----

/** Run `cccc send` via CLI. Returns stdout on success or throws on failure. */
function cliSend(groupId: string, text: string): string {
  return execSync(`cccc send --group "${groupId}" "${text.replace(/"/g, '\\"')}"`, {
    encoding: "utf-8",
    timeout: 10_000,
  });
}

/** Build a TCP endpoint config from env vars with sensible defaults. */
function buildClientConfig(): BridgeClientConfig {
  const config = defaultBridgeConfig();
  config.host = DAEMON_HOST ?? config.host;
  config.port = DAEMON_PORT;
  config.timeoutMs = 15_000;
  return config;
}

/**
 * Attempt to find a group if CCCC_GROUP_ID was not set.
 * Uses the bridge client to list groups and returns the first one.
 */
async function resolveGroupId(client: CCCCBridgeClient): Promise<string> {
  if (GROUP_ID) return GROUP_ID;
  const groups = await client.groups();
  if (groups.groups.length === 0) {
    throw new Error("No groups found on daemon. Set CCCC_GROUP_ID to specify one.");
  }
  return groups.groups[0].group_id;
}

// ---- test suite ----

describe("CCCC bridge integration", () => {
  let client: CCCCBridgeClient;
  let groupId: string;

  beforeAll(async () => {
    if (!hasDaemon) return; // will skip tests

    client = new CCCCBridgeClient();
    await client.connect(buildClientConfig());
    groupId = await resolveGroupId(client);
  });

  afterAll(async () => {
    if (!hasDaemon || !client) return;

    // Best-effort cleanup: remove the test actor if it was registered
    try {
      await client.actorRemove(groupId, TEST_ACTOR_ID);
    } catch {
      // Actor may not have been registered — ignore cleanup errors
    }
    client.disconnect();
  });

  // ---- skip guard ----

  test("daemon host is configured", () => {
    if (!hasDaemon) {
      console.warn(
        "Skipping integration tests: CCCC_DAEMON_HOST not set. " +
          "Set this env var to run against a live daemon.",
      );
    }
    // If we reach here and hasDaemon is false, the test passes as a
    // soft skip — vitest's test filter already excluded us, but just in
    // case someone runs the file directly, log the skip.
    expect(true).toBe(true);
  });

  // ---- actor registration ----

  test("registers a test actor with the daemon", async () => {
    if (!hasDaemon) return;

    const result = await client.registerActor({
      groupId,
      actorId: TEST_ACTOR_ID,
      title: "Integration Test Actor",
      runtime: "custom",
      runner: "headless",
    });

    expect(result).toBeDefined();
    expect(result.actorId).toBe(TEST_ACTOR_ID);
  });

  // ---- message delivery ----

  test("sends a message and verifies it appears in inbox", async () => {
    if (!hasDaemon) return;

    // Use CLI to send a broadcast message to the group
    cliSend(groupId, TEST_MESSAGE_TEXT);

    // Poll inbox for the test actor until message appears or timeout
    const deadline = Date.now() + 15_000;
    let found = false;
    let lastError: unknown;

    while (Date.now() < deadline) {
      try {
        const messages = await client.inboxList({
          groupId,
          actorId: TEST_ACTOR_ID,
          limit: 10,
        });

        found = messages.some((m) => {
          const text = m.data?.text;
          return typeof text === "string" && text.includes(TEST_MESSAGE_TEXT);
        });

        if (found) break;
      } catch (err) {
        lastError = err;
      }

      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

    if (!found && lastError) {
      // Re-throw the last poll error for a clearer failure
      throw lastError;
    }
    expect(found).toBe(true);
  });

  // ---- group operations ----

  test("lists groups from the daemon", async () => {
    if (!hasDaemon) return;

    const result = await client.groups();
    expect(result).toBeDefined();
    expect(Array.isArray(result.groups)).toBe(true);
    expect(result.groups.length).toBeGreaterThan(0);
  });

  test("shows group details", async () => {
    if (!hasDaemon) return;

    const result = await client.groupShow(groupId);
    expect(result).toBeDefined();
    expect(result.group?.group_id).toBe(groupId);
  });

  // ---- actor removal ----

  test("removes the test actor", async () => {
    if (!hasDaemon) return;

    await expect(client.actorRemove(groupId, TEST_ACTOR_ID)).resolves.toBeUndefined();
  });
});
