/**
 * Actor identity management for the CCCC bridge extension.
 *
 * Identity resolution order:
 * 1. `config.actorId` (env var override)
 * 2. Cached value from state file
 * 3. Auto-generated ID
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { basename } from "node:path";
import type { BridgeConfig } from "./config.ts";
import type { CCCCBridgeClient } from "./client.ts";

/**
 * Derive the project name from git repo root (or cwd basename as fallback).
 */
function getProjectName(): string {
  try {
    const repoRoot = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    return basename(repoRoot);
  } catch {
    return basename(process.cwd());
  }
}

/**
 * Generate a deterministic actor ID in the format:
 * `<role>-<machine>-<project>`
 *
 * @param opts - Optional overrides for role, machine, and project.
 *   - `role`: from `CCCC_AGENT_ROLE` env, defaults to `"pi"`
 *   - `machine`: short hostname
 *   - `project`: git repo basename or cwd basename
 */
export function generateActorId(opts?: {
  role?: string;
  machine?: string;
  project?: string;
}): string {
  const role = opts?.role ?? process.env.CCCC_AGENT_ROLE ?? "pi";
  const machine = opts?.machine ?? os.hostname().split(".")[0];
  const project = opts?.project ?? getProjectName();
  return `${role}-${machine}-${project}`;
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
      /Name already exists/i.test(message) ||
      /actor.*already (exists|registered)/i.test(message) ||
      /actor_exists/i.test(message) ||
      /Name already exists/i.test(causeMessage) ||
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
