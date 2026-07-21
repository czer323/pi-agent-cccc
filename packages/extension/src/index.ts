import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { defaultBridgeConfig, BridgeClientError } from "./types.ts";
import { CCCCBridgeClient } from "./client.ts";
import { ensureRegistered } from "./actor.ts";
import { InboxPoller } from "./inbox.ts";
import { join } from "node:path";
import { homedir } from "node:os";

const STATE_FILE = join(homedir(), ".pi", "agent", "extensions", "cccc-bridge-state.json");

export default function (pi: ExtensionAPI) {
  let client: CCCCBridgeClient | null = null;
  let poller: InboxPoller | null = null;

  pi.on("session_start", async (_event, ctx) => {
    const config = loadConfig();
    if (!config.groupId) return; // inert when unconfigured

    try {
      // Connect to daemon
      client = new CCCCBridgeClient();
      await client.connect(defaultBridgeConfig());

      // Register actor (idempotent)
      const actorId = await ensureRegistered(client, config, config.groupId, STATE_FILE);

      // Start polling
      poller = new InboxPoller({
        client,
        groupId: config.groupId,
        actorId,
        pollIntervalMs: config.pollIntervalMs,
        pi,
      });
      poller.start();

      if (ctx.hasUI) {
        ctx.ui.setStatus("cccc", "connected");
        ctx.ui.notify("CCCC bridge connected", "info");
      }
    } catch (err) {
      // Graceful degradation — session works without CCCC
      console.error("[cccc-bridge] Failed to connect:", err);
      if (ctx.hasUI) {
        const msg =
          err instanceof BridgeClientError ? err.message : "Failed to connect to CCCC daemon";
        ctx.ui.notify(`CCCC bridge: ${msg}`, "error");
        ctx.ui.setStatus("cccc", "disconnected");
      }
    }
  });

  pi.on("session_shutdown", async () => {
    poller?.stop();
    poller = null;
    client?.disconnect();
    client = null;
  });
}
