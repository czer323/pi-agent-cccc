import type {
  ExtensionAPI,
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { loadConfig } from "./config.ts";
import { defaultBridgeConfig, BridgeClientError } from "./types.ts";
import { CCCCBridgeClient } from "./client.ts";
import {
  ensureRegistered,
  isNameAlreadyExistsError,
  buildActorId,
  MAX_ACTOR_ID_LENGTH,
} from "./actor.ts";
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
 *
 * Strips the parent's random suffix and appends `-child-<hash>`.
 * The project name is truncated if the total would exceed
 * the 32-character CCCC daemon limit.
 */
function deriveChildActorId(parentActorId: string): string {
  const shortHash = randomUUID().split("-")[0].substring(0, 6);
  // Strip parent's random6 suffix (e.g. "-abc123") to reclaim space
  const parentBase = parentActorId.replace(/-[a-z0-9]{6}$/, "");
  const suffix = `child-${shortHash}`;
  const full = `${parentBase}-${suffix}`;
  if (full.length <= MAX_ACTOR_ID_LENGTH) return full;

  // Extract components from parent base and truncate the project
  const parts = parentBase.split("-");
  if (parts.length < 3) return full.slice(0, MAX_ACTOR_ID_LENGTH);

  const [role, machine, ...projectParts] = parts;
  const project = projectParts.join("-");
  return buildActorId(role, machine, project, suffix);
}

export default function (pi: ExtensionAPI) {
  const connections = new Map<string, GroupConnection>();
  let inboxQueue: InboxQueue | null = null;
  // Captured from session_start for use in session_shutdown (no ctx param in shutdown event)
  let sessionCtx: ExtensionContext | null = null;
  const config = loadConfig();

  /**
   * Register cccc_send and cccc_reply tools so the agent can send messages
   * and reply to events through the bridge's daemon connection.
   */
  function registerTools(config: import("./config.ts").BridgeConfig) {
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
      execute: async (
        _toolCallId: string,
        params: { groupId?: string; text: string; to?: string },
        _signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<{ eventId?: string; groupId?: string }>,
        _ctx?: ExtensionContext,
      ) => {
        const groupId = params.groupId ?? connections.keys().next().value;
        if (!groupId || !connections.has(groupId)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Not connected to group "${groupId || "(none)"}"`,
              },
            ],
            details: {
              eventId: undefined as string | undefined,
              groupId: undefined as string | undefined,
            },
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
      execute: async (
        _toolCallId: string,
        params: { eventId: string; groupId?: string; text: string },
        _signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<{ eventId?: string; groupId?: string }>,
        _ctx?: ExtensionContext,
      ) => {
        const groupId = params.groupId ?? connections.keys().next().value;
        if (!groupId || !connections.has(groupId)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Not connected to group "${groupId || "(none)"}"`,
              },
            ],
            details: {
              eventId: undefined as string | undefined,
              groupId: undefined as string | undefined,
            },
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
      execute: async (
        _toolCallId: string,
        _params: Record<string, never>,
        _signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<{ actorId?: string; groupIds?: string[] }>,
        _ctx?: ExtensionContext,
      ) => {
        if (connections.size === 0) {
          return {
            content: [{ type: "text" as const, text: "Not connected to any CCCC group" }],
            details: {
              actorId: undefined as string | undefined,
              groupIds: undefined as string[] | undefined,
            },
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

    // ---- cccc_list_actors tool ----
    pi.registerTool({
      name: "cccc_list_actors",
      label: "CCCC List Actors",
      description:
        "Lists all actors in the connected CCCC group with their ID, title, runtime, runner, and state.",
      promptSnippet: "List actors in the current CCCC group",
      parameters: Type.Object({}),
      execute: async (
        _toolCallId: string,
        _params: Record<string, never>,
        _signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<{ groupId?: string; actorCount?: number }>,
        _ctx?: ExtensionContext,
      ) => {
        if (connections.size === 0) {
          return {
            content: [{ type: "text" as const, text: "Not connected to any CCCC group" }],
            details: {
              groupId: undefined as string | undefined,
              actorCount: undefined as number | undefined,
            },
          };
        }
        const groupId = connections.keys().next().value;
        if (groupId == null) {
          return {
            content: [{ type: "text" as const, text: "Not connected to any CCCC group" }],
            details: {
              groupId: undefined as string | undefined,
              actorCount: undefined as number | undefined,
            },
          };
        }
        if (connections.size > 1) {
          console.warn(
            `[cccc-bridge] Multiple groups connected; using first group "${groupId}" for cccc_list_actors.`,
          );
        }
        const conn = connections.get(groupId)!;
        const detail = await conn.client.groupShow(groupId);
        const actors = detail.actors ?? [];
        const lines = actors.map(
          (a: {
            id?: string;
            title?: string;
            runtime?: string;
            runner?: string;
            running?: boolean;
          }) => {
            const state = a.running ? "running" : "idle";
            return `${a.id} | ${a.title ?? "-"} | ${a.runtime ?? "-"} | ${a.runner ?? "-"} | ${state}`;
          },
        );
        return {
          content: [
            {
              type: "text" as const,
              text: lines.length ? lines.join("\n") : "No actors found in group.",
            },
          ],
          details: { groupId, actorCount: actors.length },
        };
      },
    });

    // ---- cccc_rename tool ----
    pi.registerTool({
      name: "cccc_rename",
      label: "CCCC Rename",
      description: "Update the agent's display title in the CCCC Web UI without reconnecting.",
      promptSnippet: "Rename my agent display name",
      parameters: Type.Object({
        title: Type.String({ description: "New display title for this agent" }),
      }),
      execute: async (
        _toolCallId: string,
        params: { title: string },
        _signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<{ oldTitle?: string; newTitle?: string }>,
        _ctx?: ExtensionContext,
      ) => {
        if (connections.size === 0) {
          return {
            content: [{ type: "text" as const, text: "Not connected to any CCCC group" }],
            details: {
              oldTitle: undefined as string | undefined,
              newTitle: undefined as string | undefined,
            },
          };
        }
        const oldTitle = config.agentTitle;
        config.agentTitle = params.title;

        for (const [groupId, conn] of connections) {
          await conn.client.registerActor({
            groupId,
            actorId: conn.actorId,
            runtime: "custom",
            runner: "headless",
            title: params.title,
          });
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Agent renamed from "${oldTitle}" to "${params.title}"`,
            },
          ],
          details: { oldTitle, newTitle: params.title },
        };
      },
    });
  }

  /**
   * Register slash commands so commands are immediately available in the palette.
   * Handlers check connections.size at execution time.
   */
  function registerCommands() {
    /**
     * Parse a --group <id> prefix from the command args string.
     * Returns { groupId, rest } where rest is the remaining text without the --group prefix.
     */
    function parseGroupFlag(args: string): { groupId: string | null; rest: string } {
      const trimmed = args.trim();
      const match = trimmed.match(/^--group\s+(\S+)\s*(.*)$/s);
      if (match) {
        return { groupId: match[1], rest: match[2].trim() };
      }
      return { groupId: null, rest: trimmed };
    }

    /**
     * Resolve the target group ID. If --group was specified, validates it exists.
     * If exactly one group is connected, uses it automatically.
     * If multiple groups are connected and no --group given, returns null and
     * already notified the user.
     */
    function resolveGroup(groupIdOpt: string | null, _ctx: any): string | null {
      const groupIds = Array.from(connections.keys());
      if (connections.size === 0) {
        _ctx.ui.notify("CCCC: Not connected", "warning");
        return null;
      }
      if (groupIdOpt) {
        if (!connections.has(groupIdOpt)) {
          _ctx.ui.notify(`CCCC: Not connected to group "${groupIdOpt}"`, "warning");
          return null;
        }
        return groupIdOpt;
      }
      if (groupIds.length === 1) {
        return groupIds[0];
      }
      // Multiple groups, no --group specified
      _ctx.ui.notify(
        `Multiple groups connected. Specify --group <id>. Connected: ${groupIds.join(", ")}`,
        "warning",
      );
      return null;
    }

    // ---- /cccc-config command ----
    pi.registerCommand("cccc-config", {
      description:
        "Show CCCC configuration: daemon host, port, groups, actor, title, poll interval",
      handler: async (_args, _ctx) => {
        if (connections.size === 0) {
          _ctx.ui.notify("CCCC: Not connected", "warning");
          return;
        }
        const groups = Array.from(connections.entries()).map(
          ([gid, conn]) => `  ${gid} → Actor: ${conn.actorId}`,
        );
        _ctx.ui.notify(
          `CCCC Config:\n` +
            `  Daemon: ${config.daemonHost}:${config.daemonPort}\n` +
            `  Groups:\n${groups.join("\n")}\n` +
            `  Title: ${config.agentTitle}\n` +
            `  Poll: ${config.pollIntervalMs}ms\n` +
            `  Sub-agent title: ${config.subAgentTitle}\n` +
            `  Auto-discover: ${config.autoDiscover ? "enabled" : "disabled"}\n` +
            `  Default group: ${config.defaultGroupId ?? "(none)"}`,
          "info",
        );
      },
    });

    // ---- /cccc-status command ----
    pi.registerCommand("cccc-status", {
      description: "Show CCCC connection status: actor ID per group, connection state",
      handler: async (_args, _ctx) => {
        if (connections.size === 0) {
          _ctx.ui.notify("CCCC: Not connected", "warning");
          return;
        }
        const lines = Array.from(connections.entries()).map(
          ([gid, conn]) => `  ${gid} → Actor: ${conn.actorId}`,
        );
        _ctx.ui.notify(
          `CCCC Status:\n${lines.join("\n")}\n  Title: ${config.agentTitle}\n  State: connected`,
          "info",
        );
      },
    });

    // ---- /cccc-actors command ----
    pi.registerCommand("cccc-actors", {
      description: "List all actors in a CCCC group. Usage: /cccc-actors [--group <id>]",
      handler: async (args, _ctx) => {
        if (connections.size === 0) {
          _ctx.ui.notify("CCCC: Not connected", "warning");
          return;
        }
        const { groupId: groupOpt } = parseGroupFlag(args);
        const groupId = resolveGroup(groupOpt, _ctx);
        if (!groupId) return;
        const conn = connections.get(groupId)!;
        try {
          const detail = await conn.client.groupShow(groupId);
          const actors = detail.actors ?? [];
          if (actors.length === 0) {
            _ctx.ui.notify("CCCC: No actors found in group", "info");
            return;
          }
          const lines = actors.map(
            (a: { id?: string; title?: string; running?: boolean }) =>
              `${a.id} | ${a.title ?? "-"} | ${a.running ? "running" : "idle"}`,
          );
          _ctx.ui.notify(`CCCC Actors in ${groupId}:\n${lines.join("\n")}`, "info");
        } catch (err) {
          _ctx.ui.notify(
            `CCCC: Failed to list actors: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
        }
      },
    });

    // ---- /cccc-send command ----
    pi.registerCommand("cccc-send", {
      description: "Send a message. Usage: /cccc-send [--group <id>] <text>",
      handler: async (args, _ctx) => {
        if (connections.size === 0) {
          _ctx.ui.notify("CCCC: Not connected", "warning");
          return;
        }
        const { groupId: groupOpt, rest } = parseGroupFlag(args);
        const text = rest;
        if (!text) {
          _ctx.ui.notify("Usage: /cccc-send [--group <id>] <message text>", "warning");
          return;
        }
        const groupId = resolveGroup(groupOpt, _ctx);
        if (!groupId) return;
        const conn = connections.get(groupId)!;
        try {
          const result = await conn.client.send({ groupId, text });
          _ctx.ui.notify(`CCCC: Message sent (event_id: ${result.event.id})`, "info");
        } catch (err) {
          _ctx.ui.notify(
            `CCCC: Send failed: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
        }
      },
    });

    // ---- /cccc-inbox command ----
    pi.registerCommand("cccc-inbox", {
      description: "Show unread CCCC inbox messages. Usage: /cccc-inbox [--group <id>]",
      handler: async (args, _ctx) => {
        if (connections.size === 0) {
          _ctx.ui.notify("CCCC: Not connected", "warning");
          return;
        }
        const { groupId: groupOpt } = parseGroupFlag(args);
        const groupId = resolveGroup(groupOpt, _ctx);
        if (!groupId) return;
        const conn = connections.get(groupId)!;
        try {
          const events = await conn.client.inboxList({
            groupId,
            actorId: conn.actorId,
            limit: 10,
          });
          if (events.length === 0) {
            _ctx.ui.notify("CCCC: No unread messages", "info");
            return;
          }
          const lines = events.map(
            (e: { id: string; by?: string; data?: { text?: string } }) =>
              `[${e.id}] ${e.by ?? "?"}: ${e.data?.text ?? "(no text)"}`,
          );
          _ctx.ui.notify(`CCCC Inbox (${events.length}):\n${lines.join("\n")}`, "info");
        } catch (err) {
          _ctx.ui.notify(
            `CCCC: Inbox fetch failed: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
        }
      },
    });

    // ---- /cccc-rename command ----
    pi.registerCommand("cccc-rename", {
      description: "Rename the agent's display title. Usage: /cccc-rename <new title>",
      handler: async (args, _ctx) => {
        const newTitle = args.trim();
        if (!newTitle) {
          _ctx.ui.notify("Usage: /cccc-rename <new title>", "warning");
          return;
        }
        if (connections.size === 0) {
          _ctx.ui.notify("CCCC: Not connected", "warning");
          return;
        }
        const oldTitle = config.agentTitle;
        config.agentTitle = newTitle;
        for (const [groupId, conn] of connections) {
          try {
            await conn.client.registerActor({
              groupId,
              actorId: conn.actorId,
              runtime: "custom",
              runner: "headless",
              title: newTitle,
            });
          } catch (err) {
            _ctx.ui.notify(
              `CCCC: Rename failed for group "${groupId}": ${err instanceof Error ? err.message : String(err)}`,
              "error",
            );
            return;
          }
        }
        _ctx.ui.notify(`CCCC: Agent renamed from "${oldTitle}" to "${newTitle}"`, "info");
      },
    });
  }

  // Register commands at factory scope so they appear in the palette immediately
  registerCommands();

  pi.on("session_start", async (_event, ctx) => {
    sessionCtx = ctx;

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
            title: config.subAgentTitle,
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
          const actorId = await ensureRegistered(client, config, groupId, {
            title: config.agentTitle,
          });

          // Publish parent actor ID so future sub-agents in this process can detect
          process.env[`${PARENT_ACTOR_ENV_PREFIX}${groupId}`] = actorId;
          // Broadcast online status to group
          try {
            await client.send({
              groupId,
              text: `Agent ${actorId} online`,
            });
          } catch (err) {
            console.error(`[cccc-bridge] Failed to broadcast online status for "${actorId}":`, err);
          }

          // Shared dedup set: streamer → poller fallback continuity
          const seenIds = new Set<string>();

          // Reconnection handler: re-register actor and broadcast online
          const onReconnect = async () => {
            try {
              await client.registerActor({
                groupId,
                actorId,
                runtime: "custom",
                runner: "headless",
                title: config.agentTitle,
              });
            } catch (err) {
              // Actor may already be registered from a previous session
              // that was not cleaned up (e.g. OMP crash, unclean shutdown).
              if (isNameAlreadyExistsError(err)) {
                console.log(
                  "[cccc-bridge] Actor already registered, reusing existing registration",
                );
              } else {
                console.error(`[cccc-bridge] Reconnect handler failed for "${actorId}":`, err);
                return;
              }
            }

            try {
              await client.send({
                groupId,
                text: `Agent ${actorId} online`,
              });
              if (ctx.hasUI) {
                ctx.ui.notify("[cccc-bridge] Reconnected to daemon", "info");
              }
              console.log(`[cccc-bridge] Re-registered actor "${actorId}" after reconnect`);
            } catch (err) {
              console.error(`[cccc-bridge] Failed to send online status after reconnect:`, err);
            }
          };

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
              onReconnect,
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
            onReconnect,
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
      registerTools(config);
      console.log("[cccc-bridge] CCCC coordination skill available: skill://cccc-coordination");
    }
  });

  pi.on("agent_end", async () => {
    inboxQueue?.wake();
  });

  pi.on("session_shutdown", async () => {
    if (sessionCtx?.hasUI) {
      sessionCtx.ui.setStatus("cccc", "disconnected");
    }
    for (const [groupId, conn] of connections) {
      conn.streamer?.stop();
      conn.poller?.stop();
      // Broadcast offline status before removing actor
      try {
        await conn.client.send({
          groupId,
          text: `Agent ${conn.actorId} going offline`,
        });
      } catch {
        // Daemon may be down — silent on shutdown
      }
      try {
        await conn.client.actorRemove(groupId, conn.actorId);
      } catch {
        // Daemon may be down — silent on shutdown
      }
      conn.client.disconnect();
      console.log(`[cccc-bridge] Disconnected group "${groupId}"`);
    }
    connections.clear();
    inboxQueue?.destroy();
    inboxQueue = null;
  });
}
