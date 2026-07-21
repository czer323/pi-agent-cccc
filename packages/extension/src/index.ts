import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { defaultBridgeConfig, BridgeClientError } from "./types.ts";
import { CCCCBridgeClient } from "./client.ts";
import { ensureRegistered } from "./actor.ts";
import { InboxPoller } from "./inbox.ts";
import { join } from "node:path";
import { homedir } from "node:os";

const STATE_FILE = join(homedir(), ".pi", "agent", "extensions", "cccc-bridge-state.json");

interface GroupConnection {
  client: CCCCBridgeClient;
  poller: InboxPoller | null;
  actorId: string;
}

export default function (pi: ExtensionAPI) {
  const connections = new Map<string, GroupConnection>();

  pi.on("session_start", async (_event, ctx) => {
    const config = loadConfig();
    if (config.groups.length === 0) return;

    for (const groupId of config.groups) {
      try {
        const client = new CCCCBridgeClient();
        await client.connect(defaultBridgeConfig());

        const actorId = await ensureRegistered(client, config, groupId, STATE_FILE);

        const poller = new InboxPoller({
          client,
          groupId,
          actorId,
          pollIntervalMs: config.pollIntervalMs,
          pi,
        });
        poller.start();

        connections.set(groupId, { client, poller, actorId });
      } catch (err) {
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
  });

  pi.on("session_shutdown", async () => {
    for (const [groupId, conn] of connections) {
      conn.poller?.stop();
      conn.client.disconnect();
      console.log(`[cccc-bridge] Disconnected group "${groupId}"`);
    }
    connections.clear();
  });
}
