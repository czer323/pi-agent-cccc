import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { defaultBridgeConfig, BridgeClientError } from "./types.ts";
import { CCCCBridgeClient } from "./client.ts";
import { ensureRegistered } from "./actor.ts";
import { discoverGroups } from "./discovery.ts";
import { InboxPoller } from "./inbox.ts";
import { InboxStreamer } from "./streamer.ts";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const STATE_FILE = join(homedir(), ".pi", "agent", "extensions", "cccc-bridge-state.json");

const PARENT_ACTOR_ENV_PREFIX = "CCCC_PARENT_ACTOR_";

interface GroupConnection {
  client: CCCCBridgeClient;
  streamer: InboxStreamer | null;
  poller: InboxPoller | null;
  actorId: string;
}

/**
 * Check whether the current session is a sub-agent by looking for parent
 * actor env vars set by a prior (parent) session in the same process.
 */
function isSubAgentSession(groups: string[]): string | null {
  for (const groupId of groups) {
    const parentActorId = process.env[`${PARENT_ACTOR_ENV_PREFIX}${groupId}`];
    if (parentActorId) return parentActorId;
  }
  return null;
}

/**
 * Derive a child actor ID from the parent actor ID.
 */
function deriveChildActorId(parentActorId: string): string {
  const shortHash = randomUUID().split("-")[0];
  return `${parentActorId}-child-${shortHash}`;
}

export default function (pi: ExtensionAPI) {
  const connections = new Map<string, GroupConnection>();
  pi.on("session_start", async (_event, ctx) => {
    const config = loadConfig();

    // Resolve effective groups: explicit config, auto-discovery, or default fallback
    let effectiveGroups = config.groups;

    if (config.groups.length === 0 && config.autoDiscover) {
      const discoveryClient = new CCCCBridgeClient();
      try {
        await discoveryClient.connect(defaultBridgeConfig());
        const discovered = await discoverGroups(discoveryClient, process.cwd());
        if (discovered.length > 0) {
          effectiveGroups = discovered;
          console.log(`[cccc-bridge] Auto-discovered groups: ${discovered.join(", ")}`);
        } else if (config.defaultGroupId) {
          effectiveGroups = [config.defaultGroupId];
          console.log(
            `[cccc-bridge] No matching groups found; using default: ${config.defaultGroupId}`,
          );
        }
      } catch (err) {
        console.error("[cccc-bridge] Auto-discovery failed:", err);
      } finally {
        discoveryClient.disconnect();
      }
    }

    // If no groups resolved, remain inert
    if (effectiveGroups.length === 0) return;

    // Detect sub-agent session: check if a parent actor already registered
    const parentActorIdForGroup = isSubAgentSession(effectiveGroups);

    if (parentActorIdForGroup) {
      // ---- Sub-agent mode ----
      for (const groupId of effectiveGroups) {
        try {
          const parentActorId = process.env[`${PARENT_ACTOR_ENV_PREFIX}${groupId}`];
          if (!parentActorId) continue;

          const childActorId = deriveChildActorId(parentActorId);

          const client = new CCCCBridgeClient();
          await client.connect(defaultBridgeConfig());

          await client.registerActor({
            groupId,
            actorId: childActorId,
            runtime: "custom",
            runner: "headless",
            title: "Pi Sub-Agent",
          });

          // Announce readiness to parent actor
          await client.send({
            groupId,
            text: `Sub-agent ready: ${childActorId}`,
            to: [parentActorId],
          });

          console.log(
            `[cccc-bridge] Sub-agent registered as "${childActorId}" in group "${groupId}"`,
          );

          // Sub-agent is ephemeral — no streamer/poller needed
          connections.set(groupId, { client, streamer: null, poller: null, actorId: childActorId });
        } catch (err) {
          console.error(`[cccc-bridge] Sub-agent failed for group "${groupId}":`, err);
        }
      }
    } else {
      // ---- Parent / main session mode ----
      for (const groupId of effectiveGroups) {
        try {
          // Connect to daemon
          const client = new CCCCBridgeClient();
          await client.connect(defaultBridgeConfig());

          // Register actor (idempotent) — per-group
          const actorId = await ensureRegistered(client, config, groupId, STATE_FILE);

          // Publish parent actor ID so future sub-agents in this process can detect
          process.env[`${PARENT_ACTOR_ENV_PREFIX}${groupId}`] = actorId;

          // Shared dedup set: streamer → poller fallback continuity
          const seenIds = new Set<string>();

          // Fallback polling starter
          let poller: InboxPoller | null = null;
          const startPoller = () => {
            if (poller) return;
            poller = new InboxPoller({
              client,
              groupId,
              actorId,
              pollIntervalMs: config.pollIntervalMs,
              pi,
              seenIds,
            });
            poller.start();
          };

          // Start with event stream
          const streamer = new InboxStreamer({
            client,
            groupId,
            actorId,
            pi,
            onFallback: startPoller,
            seenIds,
          });
          streamer.start();

          connections.set(groupId, { client, streamer, poller, actorId });
        } catch (err) {
          // Graceful degradation — per-group failure doesn't block other groups
          console.error(`[cccc-bridge] Failed to connect group "${groupId}":`, err);
          if (ctx.hasUI) {
            const msg =
              err instanceof BridgeClientError
                ? err.message
                : `Failed to connect CCCC group "${groupId}"`;
            ctx.ui.notify(`CCCC bridge: ${msg}`, "error");
          }
        }
      }

      const connectedCount = connections.size;
      if (ctx.hasUI && connectedCount > 0) {
        ctx.ui.setStatus("cccc", "connected");
        ctx.ui.notify(
          `CCCC bridge connected (${connectedCount} group${connectedCount !== 1 ? "s" : ""})`,
          "info",
        );
      }
    }
  });

  pi.on("session_shutdown", async () => {
    for (const [groupId, conn] of connections) {
      conn.streamer?.stop();
      conn.poller?.stop();
      conn.client.disconnect();
      console.log(`[cccc-bridge] Disconnected group "${groupId}"`);
    }
    connections.clear();
  });
}
