/**
 * Actor identity management for the CCCC bridge extension.
 *
 * Identity resolution order:
 * 1. `config.actorId` (env var override)
 * 2. Auto-generated unique ID per session
 *
 * Actor IDs are unique per session — they include a random suffix,
 * so no caching or idempotent registration is needed.
 */

import { execSync } from "node:child_process";
import os from "node:os";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
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
 * Maximum actor ID length enforced by the CCCC daemon.
 */
export const MAX_ACTOR_ID_LENGTH = 32;

/**
 * Build an actor ID from pre-cleaned components, truncating the project name
 * if the total ID would exceed {@link MAX_ACTOR_ID_LENGTH}.
 *
 * The random suffix is always preserved; only the project portion is shortened.
 */
export function buildActorId(
  role: string,
  machine: string,
  project: string,
  suffix: string,
): string {
  const id = `${role}-${machine}-${project}-${suffix}`;
  if (id.length <= MAX_ACTOR_ID_LENGTH) return id;
  // Truncate the project part to fit within the limit
  const overhead = role.length + 1 + machine.length + 1 + 1 + suffix.length;
  const maxProject = MAX_ACTOR_ID_LENGTH - overhead;
  const truncated = project.slice(0, Math.max(1, maxProject));
  return `${role}-${machine}-${truncated}-${suffix}`;
}
/**
 * Generate a unique actor ID per session in the format:
 * `<role>-<machine>-<project>-<random6>`
 *
 * The random suffix ensures every session gets a unique ID.
 * The project name is automatically truncated if the total would exceed
 * {@link MAX_ACTOR_ID_LENGTH} (32 chars).
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
  const suffix = randomUUID().split("-")[0].substring(0, 6);
  const clean = (s: string) =>
    s
      .replace(/[^a-zA-Z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  return buildActorId(clean(role), clean(machine), clean(project), suffix);
}

/**
 * Resolve the actor ID following the priority chain:
 * 1. Explicit override via config.actorId
 * 2. Auto-generated unique ID
 *
 * @returns The resolved actor ID.
 */
export function getActorId(config: BridgeConfig): string {
  // 1. Explicit override
  if (config.actorId) return config.actorId;

  // 2. Auto-generate unique ID
  return generateActorId();
}

/**
 * Ensure an actor is registered with the CCCC daemon.
 *
 * Generates a unique per-session ID and registers it. Since IDs are unique,
 * no idempotency handling is needed — every call creates a fresh actor.
 *
 * @returns The registered actor ID.
 */
export async function ensureRegistered(
  client: CCCCBridgeClient,
  config: BridgeConfig,
  groupId: string,
): Promise<string> {
  const actorId = getActorId(config);

  await client.registerActor({
    groupId,
    actorId,
    runtime: "custom",
    runner: "headless",
    title: "Pi Agent",
  });

  return actorId;
}
