/**
 * Actor identity management for the CCCC bridge extension.
 *
 * Identity resolution order:
 * 1. `config.actorId` (env var override)
 * 2. Cached value from state file
 * 3. Auto-generated ID
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import type { BridgeConfig } from "./config.ts";
import type { CCCCBridgeClient } from "./client.ts";

/**
 * Generate a deterministic actor ID in the format:
 * `pi-<hostname-short>-<6-char-sha256-hex-of-cwd>`
 */
export function generateActorId(): string {
  const hostname = os.hostname().split(".")[0];
  const hash = createHash("sha256").update(process.cwd()).digest("hex").slice(0, 6);
  return `pi-${hostname}-${hash}`;
}

/**
 * Resolve the actor ID following the priority chain:
 * 1. `config.actorId` (explicit override)
 * 2. Cached value from `stateFilePath`
 * 3. Auto-generated via {@link generateActorId}
 */
export function getActorId(config: BridgeConfig, stateFilePath: string): string {
  // 1. Explicit override
  if (config.actorId) return config.actorId;

  // 2. Cached value from state file
  try {
    const data = readFileSync(stateFilePath, "utf-8");
    const state = JSON.parse(data) as { actor_id?: string };
    if (state.actor_id) return state.actor_id;
  } catch {
    // File not found / invalid JSON → fall through to generate
  }

  // 3. Auto-generate
  return generateActorId();
}

/**
 * Ensure an actor is registered with the CCCC daemon.
 *
 * Resolves the actor ID (override → cache → generate), attempts
 * registration, and writes a state file on first success. If the
 * daemon reports that the actor already exists, the registration
 * is treated as idempotent — no state file is written and the
 * existing actor ID is returned.
 *
 * @returns The resolved actor ID.
 */
export async function ensureRegistered(
  client: CCCCBridgeClient,
  config: BridgeConfig,
  groupId: string,
  stateFilePath: string,
): Promise<string> {
  const actorId = getActorId(config, stateFilePath);

  try {
    await client.registerActor({
      groupId,
      actorId,
      runtime: "custom",
      runner: "headless",
      title: "Pi Agent",
    });

    // Registration succeeded — this is a first registration, write state
    const state = JSON.stringify(
      { actor_id: actorId, registered_at: new Date().toISOString() },
      null,
      2,
    );
    writeFileSync(stateFilePath, state, "utf-8");
  } catch (err) {
    // Check whether the error indicates the actor already exists
    const typed = err as Error;
    const message = typed.message ?? "";
    const causeMessage = typed.cause instanceof Error ? typed.cause.message : "";

    const actorExists =
      /actor.*already (exists|registered)/i.test(message) ||
      /actor_exists/i.test(message) ||
      /actor.*already (exists|registered)/i.test(causeMessage) ||
      /actor_exists/i.test(causeMessage);

    if (actorExists) {
      // Idempotent — actor was previously registered
      return actorId;
    }

    throw err;
  }

  return actorId;
}
