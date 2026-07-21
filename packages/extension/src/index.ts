import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { loadConfig } from "./config.ts";
import { defaultBridgeConfig, BridgeClientError } from "./types.ts";
import { CCCCBridgeClient } from "./client.ts";
import { ensureRegistered } from "./actor.ts";
import { discoverGroups } from "./discovery.ts";
import { InboxPoller } from "./inbox.ts";
import { InboxStreamer } from "./streamer.ts";
import { InboxQueue } from "./inbox-queue.ts";
import { randomUUID } from "node:crypto";

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
  let inboxQueue: InboxQueue | null = null;


  /**
   * Register cccc_send and cccc_reply tools so the agent can send messages
   * and reply to events through the bridge's daemon connection.
   */
  function registerTools() {
    // ---- cccc_send tool ----
    pi.registerTool({
      name: "cccc_send",
      label: "CCCC Send",
      description: "Send a message to a CCCC group. All group members will see the message.",
      promptSnippet: "Send messages to CCCC groups",
      promptGuidelines: [
        "Use cccc_send to send messages to CCCC groups",
        "Use cccc_reply to reply to specific events",
      ],
      parameters: Type.Object({
        text: Type.String({ description: "Message text to send" }),
        groupId: Type.Optional(
          Type.String({
            description: "Group ID (defaults to first connected group)",
          }),
        ),
        to: Type.Optional(
          Type.String({
            description: "Recipient actor ID or @all (default: @all)",
          }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        const groupId = params.groupId ?? connections.keys().next().value;
        if (!groupId || !connections.has(groupId)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Not connected to group "${groupId || "(none)"}"`,
              },
            ],
            details: {},
          };
        }
        if (!params.groupId && connections.size > 1) {
          console.warn(
            `[cccc-bridge] Multiple groups connected; using first group "${groupId}" for cccc_send. Specify groupId to target a specific group.`,
          );
        }
        const conn = connections.get(groupId)!;
        const to = params.to ? [params.to] : undefined;
        const result = await conn.client.send({ groupId, text: params.text, to });
        return {
          content: [
            {
              type: "text" as const,
              text: `Message sent (event_id: ${result.event.id})`,
            },
          ],
          details: { eventId: result.event.id, groupId },
        };
      },
    });

    // ---- cccc_reply tool ----
    pi.registerTool({
      name: "cccc_reply",
      label: "CCCC Reply",
      description: "Reply to an existing CCCC message by event ID.",
      promptSnippet: "Reply to specific CCCC messages",
      parameters: Type.Object({
        text: Type.String({ description: "Reply text" }),
        eventId: Type.String({ description: "ID of the event to reply to" }),
        groupId: Type.Optional(
          Type.String({
            description: "Group ID (defaults to first connected group)",
          }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        const groupId = params.groupId ?? connections.keys().next().value;
        if (!groupId || !connections.has(groupId)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Not connected to group "${groupId || "(none)"}"`,
              },
            ],
            details: {},
          };
        }
        if (!params.groupId && connections.size > 1) {
          console.warn(
            `[cccc-bridge] Multiple groups connected; using first group "${groupId}" for cccc_reply. Specify groupId to target a specific group.`,
          );
        }
        const conn = connections.get(groupId)!;
        const result = await conn.client.reply({
          groupId,
          replyTo: params.eventId,
          text: params.text,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Reply sent (event_id: ${result.event.id})`,
            },
          ],
          details: { eventId: result.event.id, groupId },
        };
      },
    });

    // ---- cccc_whoami tool ----
    pi.registerTool({
      name: "cccc_whoami",
      label: "CCCC Who Am I",
      description: "Returns the current CCCC actor ID and the list of connected group IDs.",
      promptSnippet: "Identify my CCCC identity",
      parameters: Type.Object({}),
      execute: async () => {
        if (connections.size === 0) {
          return {
            content: [{ type: "text" as const, text: "Not connected to any CCCC group" }],
            details: {},
          };
        }
        // Use the first connection's actorId (all connections share the same session actor)
        const firstConn = connections.values().next().value!;
        const groupIds = Array.from(connections.keys());
        return {
          content: [
            {
              type: "text" as const,
              text: `Actor ID: ${firstConn.actorId}\nGroups: ${groupIds.join(", ")}`,
            },
          ],
          details: { actorId: firstConn.actorId, groupIds },
        };
      },
    });
  }

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
    // Create shared inbox queue for idle-gated batched delivery
    inboxQueue = new InboxQueue({ pi, ctx });


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

          // Register actor with unique per-session ID
          const actorId = await ensureRegistered(client, config, groupId);

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
              queue: inboxQueue!,
              seenIds,
            });
            poller.start();
          };

          // Start with event stream
          const streamer = new InboxStreamer({
            client,
            groupId,
            actorId,
            queue: inboxQueue!,
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
        const connActorId = connections.values().next().value!.actorId;
        ctx.ui.setStatus("cccc", "connected");
        ctx.ui.notify(
          `CCCC bridge connected as "${connActorId}" (${connectedCount} group${connectedCount !== 1 ? "s" : ""})`,
          "info",
        );
      }
    }

    // Register tools for both parent and sub-agent sessions when connected
    if (connections.size > 0) {
      registerTools();
    }
  });

  pi.on("agent_end", async () => {
    inboxQueue?.wake();
  });

  pi.on("session_shutdown", async () => {
    for (const [groupId, conn] of connections) {
      conn.streamer?.stop();
      conn.poller?.stop();
      try {
        await conn.client.actorRemove(groupId, conn.actorId);
        console.log(`[cccc-bridge] Removed actor "${conn.actorId}" from group "${groupId}"`);
      } catch (err) {
        console.error(
          `[cccc-bridge] Failed to remove actor "${conn.actorId}" from group "${groupId}":`,
          err,
        );
      }
      conn.client.disconnect();
      console.log(`[cccc-bridge] Disconnected group "${groupId}"`);
    }
    connections.clear();
    inboxQueue?.destroy();
    inboxQueue = null;

  });
}
