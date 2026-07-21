# pi-agent-cccc — CCCC Bridge Extension for Pi Agent

Connect your Pi Agent session to a [CCCC](https://github.com/ChesterRa/cccc) daemon group so messages arrive in real-time — no manual inbox polling required.

## How It Works

The extension bridges external CCCC messages into Pi Agent's conversation loop. It is a **receive-only bridge**: incoming CCCC messages are delivered into the session, while sending replies is handled by Pi Agent's built-in MCP tools (`cccc_inbox_list`, `cccc_send`, etc.).

```
┌──────────────┐   TCP/9765    ┌───────────────────────┐   hooks into    ┌──────────────────┐
│  CCCC Daemon │◄─────────────│  cccc-bridge extension │───────────────│  Pi Agent session │
│  (Docker)     │ events_stream│                        │ session_start   │                  │
│               │ + inbox_list │  ┌─────────────────┐  │ before_turn     │  conversation    │
│  Web UI :8848 │              │  │ InboxStreamer   │  │ agent_settled   │  loop            │
│               │              │  │ (TCP push)      │──│─────────────►  │                  │
│  groups       │              │  │                 │  │ pi.sendMessage  │  response        │
│  actors       │              │  ├─────────────────┤  │                 │                  │
│               │              │  │ InboxPoller     │  │                 │                  │
└──────────────┘              │  │ (fallback)      │  │                 └──────────────────┘
                               │  └─────────────────┘  │
                               └───────────────────────┘
```

**Delivery path:**

1. Extension connects to daemon at session start via TCP (newline-delimited JSON)
2. Subscribes to `events_stream` for push delivery of `chat.message` events
3. Buffered messages are injected via `pi.sendMessage()` at turn boundaries
4. If the event stream disconnects, falls back to `inbox_list` polling with exponential backoff
5. Delivered messages are marked read via `inbox_mark_read`

**Sending messages** is done through Pi Agent's existing CCCC MCP tools (`cccc_send`, `cccc_reply`) — this extension only handles the inbound path.

## Prerequisites

- A running CCCC daemon (default: `192.168.7.163:9765`)
- [Pi Agent](https://github.com/earendil-works/pi-coding-agent) installed
- [pnpm](https://pnpm.io/) installed
- [Vite Plus](https://github.com/earendil-works/vite-plus) (`vp`) globally available

```bash
# Install Vite Plus via mise
mise use -g npm:vite-plus
```

## Installation

```bash
# Clone the repo
git clone git@github.com:czer323/pi-agent-cccc.git
cd pi-agent-cccc/packages/extension

# Install dependencies
pnpm install

# Symlink for pi-agent runtime discovery
ln -s "$PWD" ~/.pi/agent/extensions/cccc-bridge
```

**Verify the installation:**

```bash
# Check the extension is findable
ls -la ~/.pi/agent/extensions/cccc-bridge   # should point to packages/extension

# Run the test suite
vp test
# 7 test files, 99 tests — all passing

# Run the tollgate
vp check

# All files formatted, type-checked, linted
```

## Testing

This project uses a 4-layer testing strategy covering unit tests, integration tests,
E2E agent tests, and cross-harness tests. See [docs/testing.md](docs/testing.md) for
the full strategy documentation.

```bash
# Unit tests (fast, no daemon needed)
cd packages/extension && vp test

# Integration tests (requires live CCCC daemon)
CCCC_DAEMON_HOST=192.168.7.163 pnpm test:integration
```

## Configuration

All configuration is via environment variables:

| Variable                | Default         | Description                                                       |
| ----------------------- | --------------- | ----------------------------------------------------------------- |
| `CCCC_DAEMON_HOST`      | `192.168.7.163` | CCCC daemon TCP host                                              |
| `CCCC_DAEMON_PORT`      | `9765`          | CCCC daemon TCP port                                              |
| `CCCC_GROUP_ID`         | none            | Single group ID to join                                           |
| `CCCC_GROUP_IDS`        | none            | Comma-separated group IDs (takes precedence over `CCCC_GROUP_ID`) |
| `CCCC_ACTOR_ID`         | auto-generated  | Explicit actor ID override; format: `<role>-<machine>-<project>`  |
| `CCCC_AGENT_ROLE`       | `pi`            | Role component of auto-generated actor ID                         |
| `CCCC_POLL_INTERVAL_MS` | `3000`          | Polling fallback interval in milliseconds                         |
| `CCCC_AUTO_DISCOVER`    | `true`          | Auto-discover groups from cwd/git repo; set to `false` to disable |
| `CCCC_DEFAULT_GROUP_ID` | none            | Fallback group when auto-discovery finds no match                 |
| `CCCC_PARENT_ACTOR_ID`  | set by parent   | Set by parent session for sub-agent detection                     |
| `CCCC_PARENT_GROUP_ID`  | set by parent   | Set by parent session for sub-agent detection                     |

The actor ID auto-generates in the format `<role>-<hostname>-<project>`, e.g. `pi-truenas-pi-agent-cccc`. The project name is derived from the git repo root (or cwd basename as fallback).

When no groups are configured and `CCCC_AUTO_DISCOVER` is enabled (default), the extension queries the daemon for groups whose scoped paths match the current working directory or its git repo root. If nothing matches and `CCCC_DEFAULT_GROUP_ID` is set, that group is used as fallback.

If no groups resolve at all, the extension stays inert — Pi Agent runs normally without the bridge.

## Usage

### Single group

```bash
CCCC_GROUP_ID=g_c8878957bd2c \
  pi -ne -e ~/.pi/agent/extensions/cccc-bridge
```

On session start, the extension registers an actor with the daemon (idempotent), connects to the event stream, and starts delivering messages to the conversation. Messages appear as:

```
New CCCC message from user:

Hello, can you review this PR?
```

### Multi-group

```bash
CCCC_GROUP_IDS="g_group_a,g_group_b" \
  pi -ne -e ~/.pi/agent/extensions/cccc-bridge
```

Each group gets its own connection, actor registration, and event stream/poller. Failure of one group does not affect others.

### Auto-discovery

```bash
# Run from inside a repo whose git root matches a CCCC group scope
cd ~/projects/my-scoped-project
pi -ne -e ~/.pi/agent/extensions/cccc-bridge
```

### Disable auto-discovery

```bash
CCCC_AUTO_DISCOVER=false \
  CCCC_DEFAULT_GROUP_ID=g_my_group \
  pi -ne -e ~/.pi/agent/extensions/cccc-bridge
```

### Sub-agent mode

When Pi Agent spawns sub-agents in a process where a parent session is already connected, the sub-agents auto-detect via `CCCC_PARENT_ACTOR_<GROUP_ID>` env vars and register as child actors. Sub-agents are ephemeral and use no streamer or poller — they announce readiness and exit.

### Note on `pi-link` extension conflict

If you have the built-in `pi-link.ts` extension active and it fails with a `Cannot find module 'ws'` error, start pi with only the CCCC bridge extension loaded:

```bash
pi -ne -e ~/.pi/agent/extensions/cccc-bridge
```

The `-e` flag loads only the specified extension, avoiding the pi-link dependency issue.

## Testing

### Unit tests

```bash
cd packages/extension
vp test    # 99 tests, 7 test files
vp check   # tollgate: format + lint + type-check
```

### Manual E2E test

1. Set a `CCCC_GROUP_ID` and start pi with the extension:

```bash
CCCC_GROUP_ID=g_c8878957bd2c \
  OPENAI_API_KEY="sk-..." \
  OPENAI_BASE_URL="http://192.168.7.163:20128/v1" \
  pi -ne -e ~/.pi/agent/extensions/cccc-bridge
```

> **Provider config**: The OpenAI-compatible endpoint above is the local OmniRoute proxy. The exact `OPENAI_API_KEY` and `OPENAI_BASE_URL` values can be found in `~/.config/opencode/opencode.jsonc` under `provider.omniroute.options`.

2. Verify the actor appears in the [CCCC Web UI](http://192.168.7.163:8848/ui/) (group → actors tab).

3. Send a message from the Web UI or another agent. Verify it arrives in the Pi Agent session within a few seconds.

4. The agent's response is sent back through the daemon and visible in the Web UI.

## Architecture

### File structure

```
packages/extension/
  src/
    index.ts     # Entry point: ExtensionAPI factory, lifecycle hooks (session_start, session_shutdown)
    config.ts    # loadConfig() — env var parsing, BridgeConfig interface
    client.ts    # CCCCBridgeClient — wrapper around cccc-sdk with DI for testing
    actor.ts     # Actor identity: generateActorId(), getActorId(), ensureRegistered()
    inbox.ts     # InboxPoller — polling with dedup, formatMessage(), InboxPollerOptions
    streamer.ts  # InboxStreamer — persistent events_stream consumer with reconnection + fallback
    discovery.ts # discoverGroups() — query daemon for groups matching cwd/git scope
    types.ts     # BridgeClientConfig, CCCCClientLike interface, BridgeClientError
  tests/
    config.test.ts
    client.test.ts
    actor.test.ts
    inbox.test.ts
    streamer.test.ts
    discovery.test.ts
    index.test.ts
```

### Key classes

| Class              | File          | Role                                                                                                                                                      |
| ------------------ | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CCCCBridgeClient` | `client.ts`   | Wraps `cccc-sdk` TCP client with typed methods and error handling. Supports dependency injection for tests.                                               |
| `InboxStreamer`    | `streamer.ts` | Long-lived `events_stream` consumer via async generator. Reconnects with exponential backoff (1s, 2s, 4s, 8s, 30s). Calls `onFallback` after max retries. |
| `InboxPoller`      | `inbox.ts`    | Polling fallback using `inbox_list` on a configurable interval. Deduplicates by event ID, marks read after delivery.                                      |

### Data flow

```
session_start
  ├─ loadConfig() → BridgeConfig
  ├─ (optional) discoverGroups() via daemon groups() API
  ├─ ensureRegistered() → actor ID (idempotent)
  ├─ InboxStreamer.start() → events_stream (TCP push)
  │   └─ on disconnect: exponential backoff, then onFallback
  │       └─ InboxPoller.start() → periodic inbox_list polling
  └─ pi.sendMessage() delivers each event as a message turn

session_shutdown
  └─ streamer.stop(), poller.stop(), client.disconnect()
```

### Graceful degradation

- **Daemon unreachable**: Per-group connection failure is caught and logged; other groups continue. If `ctx.hasUI`, a toast notification is shown.
- **Stream disconnect**: Exponential backoff (1s–30s), then transparent fallback to polling. Polling inherits the stream's deduplication set for continuity.
- **No groups configured**: The extension does nothing. Pi Agent runs normally and the extension is inert.
- **Sub-agent mode**: Ephemeral registration only — no persistent connections — so spawned agents don't leave dangling sockets.

## Troubleshooting

### "Failed to connect to CCCC daemon"

The daemon at `CCCC_DAEMON_HOST:CCCC_DAEMON_PORT` is unreachable. Verify:

```bash
nc -zv 192.168.7.163 9765   # TCP connectivity
curl -s http://192.168.7.163:8848/api/health   # daemon health (if available)
```

Check that the daemon is running in its Docker container on TrueNAS and that the Anvil MCP gateway is not rate-limiting.

### "Actor already exists" / registration conflict

Actor registration is idempotent — calling `ensureRegistered` for the same actor ID is safe. If you see unexpected behavior, clear the state file:

```bash
rm ~/.pi/agent/extensions/cccc-bridge-state.json
```

This forces fresh actor identity resolution on next session start.

### No messages arriving

1. Verify `CCCC_GROUP_ID` (or `CCCC_GROUP_IDS`) is set and the group exists in the Web UI.
2. Check the daemon logs for the actor registration and event stream subscription.
3. Ensure the sender (`to` field) addresses your actor ID.
4. If using auto-discovery, verify the group's scoped path matches your cwd or git repo root.
5. If the event stream is failing silently, the extension falls back to polling after 5 retries (~45s). Watch for `[cccc-bridge]` console logs.

### pi-link "Cannot find module 'ws'"

The built-in `pi-link.ts` extension requires the `ws` WebSocket module which may not be installed in your environment. Start pi with only the CCCC bridge:

```bash
pi -ne -e ~/.pi/agent/extensions/cccc-bridge
```

### Messages not appearing in Web UI after agent responds

The extension delivers incoming messages into the conversation — it does **not** intercept the agent's response. Sending replies is handled separately through Pi Agent's CCCC MCP tools. Verify that the MCP tools are configured and that the agent model can call them correctly.

## Development

### Branch workflow

All work happens in branches off `main`. The main checkout at `~/projects/pi-agent-cccc` is shared — never edit files there directly. Use an isolated git worktree:

```bash
git worktree add .worktrees/<branch-name> -b <branch-name>
cd .worktrees/<branch-name>
pnpm install
```

### TDD requirement

This project follows test-driven development. Every feature starts with a failing test. The test patterns use `vite-plus/test` with `describe`/`test`/`expect` and `beforeEach` for env cleanup:

```typescript
import { expect, test, describe, beforeEach } from "vite-plus/test";

describe("myFeature", () => {
  test("behaves correctly", () => {
    // ...
  });
});
```

### Contribution checklist

1. Read `AGENTS.md` for the development workflow
2. Create a branch from `main` (`feature/`, `fix/`, `chore/`)
3. Write tests first (red), then implementation (green), then refactor
4. Run `vp check` — must pass before any commit
5. Commit with conventional commit message (`feat:`, `fix:`, `chore:`)
6. Push branch, create PR against `main`, get review approval
7. Merge (squash or rebase per PR context), delete branch, sync issue state

### Commands

| Command          | Purpose                                            |
| ---------------- | -------------------------------------------------- |
| `vp check`       | Tollgate: oxfmt (format) + oxlint + tsc type check |
| `vp check --fix` | Auto-format and auto-fix lint                      |
| `vp test`        | Run unit tests with vitest                         |
| `vp lint`        | Lint with oxlint                                   |
| `vp format`      | Format with oxfmt                                  |
| `vp pack`        | Build extension                                    |
