# pi-agent-cccc — CCCC Bridge Extension for Pi Agent

Connect your [Pi Agent](https://github.com/earendil-works/pi-coding-agent) session to a [CCCC](https://github.com/ChesterRa/cccc) daemon group so messages arrive in real-time — no manual inbox polling required.

The extension bridges external CCCC messages into Pi Agent's conversation loop. Incoming CCCC messages are delivered automatically; sending replies is handled by the agent's CCCC tools (`cccc_send`, `cccc_reply`).

---

## Table of Contents

- [Quick Start](#quick-start)
- [Slash Commands](#slash-commands)
- [Agent Tools](#agent-tools)
- [How Messages Work](#how-messages-work)
- [Configuration](#configuration)
- [Environment Variables](#environment-variables)
- [Architecture](#architecture)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Quick Start

### Prerequisites

- **Pi Agent / OMP** — installed and working (`pi --help` or `omp --help` prints help)
- **CCCC daemon** — running and reachable on your network (default `192.168.7.163:9765`)
- **pnpm** — package manager
- **Vite Plus** (`vp`) — available globally for development tasks

```bash
# Install Vite Plus via mise
mise use -g npm:vite-plus
```

### Installation

```bash
# Clone the repo
git clone git@github.com:czer323/pi-agent-cccc.git
cd pi-agent-cccc/packages/extension

# Install dependencies
pnpm install

# Symlink for pi-agent runtime discovery
ln -s "$PWD" ~/.pi/agent/extensions/cccc-bridge
```

### Verify the Installation

```bash
# Check the extension is findable
ls -la ~/.pi/agent/extensions/cccc-bridge   # should point to packages/extension

# Run the test suite (229 unit tests)
cd packages/extension && vp test
```

### Configuration

Set the CCCC daemon host and group ID as environment variables:

```bash
export CCCC_DAEMON_HOST=192.168.7.163
export CCCC_GROUP_ID=g_c8878957bd2c
```

See the [Environment Variables](#environment-variables) section for all available options.

### Verify It Works

Start Pi Agent with the extension loaded:

```bash
CCCC_GROUP_ID=g_c8878957bd2c \
  pi -ne -e ~/.pi/agent/extensions/cccc-bridge
```

On session start you should see a message like:

```
[cccc-bridge] CCCC bridge connected — listening on group g_c8878957bd2c
```

If you see this, the bridge is live. Messages sent to the CCCC group will now arrive in your conversation automatically.

---

## Slash Commands

All CCCC slash commands are available in the Pi Agent / OMP prompt. Type `/cccc-` and the command palette shows them.

### `/cccc-status`

Show connection status — actor ID per group, display title, and connection state.

```
/cccc-status
```

Output:

```
CCCC Status:
  g_c8878957bd2c → Actor: pi-truenas-pi-agent-cccc
  Title: Pi Agent
  State: connected
```

### `/cccc-config`

Show current configuration — daemon host, port, connected groups, actor IDs, title, poll interval, and auto-discovery settings.

```
/cccc-config
```

Output:

```
CCCC Config:
  Daemon: 192.168.7.163:9765
  Groups:
    g_c8878957bd2c → Actor: pi-truenas-pi-agent-cccc
  Title: Pi Agent
  Poll: 3000ms
  Sub-agent title: Pi Sub-Agent
  Auto-discover: enabled
  Default group: (none)
```

### `/cccc-actors`

List all actors in a CCCC group. Shows actor ID, title, and running state.

```bash
# List actors in the default (or only) group
/cccc-actors

# List actors in a specific group
/cccc-actors --group g_c8878957bd2c
```

Output:

```
CCCC Actors in g_c8878957bd2c:
  opencode-agent | OpenCode Agent | web_model | running
  pi-truenas-pi-agent-cccc | Pi Agent | custom | running
  user | User | user | idle
```

### `/cccc-send`

Send a message to the group. All group members will see it.

```bash
# Send to the default (or only) group
/cccc-send Hello, team!

# Send to a specific group
/cccc-send --group g_other_group Hello, other group!
```

Output:

```
CCCC: Message sent (event_id: evt_abc123)
```

### `/cccc-inbox`

Show unread CCCC inbox messages. Useful for checking messages that haven't been delivered to the conversation yet.

```bash
# Check inbox for the default group
/cccc-inbox

# Check inbox for a specific group
/cccc-inbox --group g_c8878957bd2c
```

Output:

```
CCCC Inbox (2):
  [evt_001] user: Can you review this PR?
  [evt_002] opencode-agent: Build passed
```

### `/cccc-rename`

Rename the agent's display title in the CCCC Web UI without reconnecting.

```
/cccc-rename Review Bot
```

Output:

```
CCCC: Agent renamed from "Pi Agent" to "Review Bot"
```

---

## Agent Tools

These tools are automatically registered by the extension when the session starts. The agent knows about them and can use them in conversation — no user intervention required. Each tool is registered via `pi.registerTool()` and appears in the agent's tool list alongside any MCP tools.

| Tool               | Description                                         |
| ------------------ | --------------------------------------------------- |
| `cccc_send`        | Send a message to a CCCC group                      |
| `cccc_reply`       | Reply to a specific CCCC message by event ID        |
| `cccc_whoami`      | Get the agent's CCCC actor ID and connected groups  |
| `cccc_list_actors` | List all actors in a CCCC group with their state    |
| `cccc_rename`      | Update the agent's display title in the CCCC Web UI |

### `cccc_send`

Send a message to a CCCC group. All group members see the message.

**Parameters:**

- `text` (string, required) — Message text to send
- `groupId` (string, optional) — Group ID; defaults to the first connected group
- `to` (string, optional) — Recipient actor ID or `@all`; defaults to `@all`

**Example agent usage:**

```
The agent uses cccc_send to broadcast results or ask questions.
Multiple groups? Specify groupId to target the right one.
```

### `cccc_reply`

Reply to an existing CCCC message by event ID. Creates a threaded reply visible in the CCCC Web UI.

**Parameters:**

- `text` (string, required) — Reply text
- `eventId` (string, required) — ID of the event to reply to
- `groupId` (string, optional) — Group ID; defaults to the first connected group

**Example:**

```
The agent uses cccc_reply to respond to a specific incoming message,
especially when reply_required is set.
```

### `cccc_whoami`

Returns the current CCCC actor ID and the list of connected group IDs. The agent typically calls this at session start to verify its identity.

**Parameters:** None

### `cccc_list_actors`

Lists all actors in the connected CCCC group with their ID, title, runtime, runner, and running state.

**Parameters:** None

**Example output:**

```
opencode-agent | OpenCode Agent | web_model | spawned | running
pi-truenas-pi-agent-cccc | Pi Agent | custom | headless | running
user | User | - | - | idle
```

### `cccc_rename`

Update the agent's display title in the CCCC Web UI without reconnecting. Re-registers the actor with the new title on all connected groups.

**Parameters:**

- `title` (string, required) — New display title for this agent

---

## How Messages Work

### Inbound Path

1. **Daemon event stream** — At session start, the extension opens a persistent TCP connection to the daemon's `events_stream` endpoint. The daemon pushes `chat.message` events addressed to the agent's groups in real-time.

2. **Buffering** — Incoming messages are buffered in an `InboxQueue` with debouncing. Messages accumulate for a short window before being delivered as a batch.

3. **Idle-gated delivery** — Messages are injected into the agent's conversation via `pi.sendMessage()`. They arrive only when the agent is idle (not mid-turn). This prevents interrupting ongoing work.

4. **Batch format** — When multiple messages arrive before the agent becomes idle, they appear as:

```
[CCCC: 3 messages received]

user: Hello, can you review this PR?
opencode-agent: Build passed for feature-branch
opencode-agent: Tests all green
```

5. **Provenance** — Each delivered message includes sender ID, group ID, and event ID (`eventId`). The agent can use `cccc_reply(eventId: ...)` to respond to a specific message.

6. **Mark read** — After delivery, messages are marked read via `inbox_mark_read` so the daemon tracks delivery state.

### Outbound Path

The agent sends replies using the `cccc_send` and `cccc_reply` tools (not through the conversation text). Replies go directly to the CCCC daemon and are visible in the Web UI and to all group members.

### What Gets Filtered

- **Own broadcasts** — Messages sent by this agent are not re-delivered as incoming events.
- **Empty system messages** — Events with no text content are silently dropped.
- **Non-message events** — Only `chat.message` kind events are delivered.

### Event Stream Resilience

If the persistent `events_stream` connection drops, the extension:

1. Reconnects with exponential backoff (1s, 2s, 4s, 8s, 30s cap)
2. Falls back transparently to `inbox_list` polling after 5 retries
3. The polling fallback runs on a configurable interval (default 3s)
4. Deduplication by event ID ensures no message is delivered twice during the transition

---

## Configuration

All configuration is via environment variables. See the table below for the full list.

### Single Group

```bash
CCCC_GROUP_ID=g_c8878957bd2c \
  pi -ne -e ~/.pi/agent/extensions/cccc-bridge
```

### Multiple Groups

```bash
CCCC_GROUP_IDS="g_group_a,g_group_b" \
  pi -ne -e ~/.pi/agent/extensions/cccc-bridge
```

Each group gets its own connection, actor registration, and event stream/poller. Failure of one group does not affect others.

### Auto-Discovery

When no group ID is set and `CCCC_AUTO_DISCOVER` is enabled (default), the extension queries the daemon for groups whose scoped paths match the current working directory or its git repo root.

```bash
# Run from inside a repo whose git root matches a CCCC group scope
cd ~/projects/my-scoped-project
pi -ne -e ~/.pi/agent/extensions/cccc-bridge
```

### Disable Auto-Discovery

```bash
CCCC_AUTO_DISCOVER=false \
  CCCC_DEFAULT_GROUP_ID=g_my_group \
  pi -ne -e ~/.pi/agent/extensions/cccc-bridge
```

If no groups resolve at all, the extension stays inert — Pi Agent runs normally without the bridge.

### Explicit Actor ID

```bash
CCCC_ACTOR_ID=my-custom-actor \
  CCCC_GROUP_ID=g_c8878957bd2c \
  pi -ne -e ~/.pi/agent/extensions/cccc-bridge
```

By default, the actor ID auto-generates in the format `<role>-<hostname>-<project>`, e.g. `pi-truenas-pi-agent-cccc`. The project name is derived from the git repo root (or cwd basename as fallback).

### Sub-Agent Mode

When Pi Agent spawns sub-agents in a process where a parent session is already connected, the sub-agents auto-detect via `CCCC_PARENT_ACTOR_<GROUP_ID>` env vars and register as child actors. Sub-agents are ephemeral and use no streamer or poller — they announce readiness and exit.

The child actor ID is derived from the parent by stripping the parent's random suffix and appending `-child-<hash>`, ensuring unique but traceable identities within the 32-character CCCC daemon limit.

### Note on `pi-link` Extension Conflict

If you have the built-in `pi-link.ts` extension active and it fails with a `Cannot find module 'ws'` error, start pi with only the CCCC bridge extension loaded:

```bash
pi -ne -e ~/.pi/agent/extensions/cccc-bridge
```

The `-e` flag loads only the specified extension, avoiding the pi-link dependency issue.

---

## Environment Variables

| Variable                | Required        | Default         | Description                                                       |
| ----------------------- | --------------- | --------------- | ----------------------------------------------------------------- |
| `CCCC_DAEMON_HOST`      | Yes             | `192.168.7.163` | CCCC daemon TCP host                                              |
| `CCCC_DAEMON_PORT`      | No              | `9765`          | CCCC daemon TCP port                                              |
| `CCCC_GROUP_ID`         | See note        | —               | Single group ID to join                                           |
| `CCCC_GROUP_IDS`        | See note        | —               | Comma-separated group IDs (takes precedence over `CCCC_GROUP_ID`) |
| `CCCC_ACTOR_ID`         | No              | auto-generated  | Explicit actor ID override; format: `<role>-<machine>-<project>`  |
| `CCCC_AGENT_ROLE`       | No              | `pi`            | Role prefix for auto-generated actor ID                           |
| `CCCC_AGENT_TITLE`      | No              | `Pi Agent`      | Display title in CCCC Web UI                                      |
| `CCCC_SUB_AGENT_TITLE`  | No              | `Pi Sub-Agent`  | Display title for sub-agents in CCCC Web UI                       |
| `CCCC_POLL_INTERVAL_MS` | No              | `3000`          | Polling fallback interval in milliseconds                         |
| `CCCC_AUTO_DISCOVER`    | No              | `true`          | Auto-discover groups from cwd/git repo; set to `false` to disable |
| `CCCC_DEFAULT_GROUP_ID` | No              | —               | Fallback group when auto-discovery finds no match                 |
| `CCCC_PARENT_ACTOR_ID`  | (set by parent) | —               | Set by parent session for sub-agent detection                     |
| `CCCC_PARENT_GROUP_ID`  | (set by parent) | —               | Set by parent session for sub-agent detection                     |

> **Note on group requirement:** You must set either `CCCC_GROUP_ID`, `CCCC_GROUP_IDS`, or have `CCCC_AUTO_DISCOVER` enabled with a matching group. If no group is resolved, the extension stays inert.

---

## Architecture

### File Structure

```
packages/extension/
  src/
    index.ts      # Entry point: ExtensionAPI factory, lifecycle hooks, tool & command registration
    config.ts     # loadConfig() — env var parsing, BridgeConfig interface
    client.ts     # CCCCBridgeClient — wrapper around cccc-sdk with DI for testing
    actor.ts      # Actor identity: generateActorId(), getActorId(), ensureRegistered()
    inbox.ts      # InboxPoller — polling with dedup, formatMessage()
    inbox-queue.ts # InboxQueue — debounced batching of incoming events
    streamer.ts   # InboxStreamer — persistent events_stream consumer with reconnection + fallback
    discovery.ts  # discoverGroups() — query daemon for groups matching cwd/git scope
    types.ts      # BridgeClientConfig, CCCCClientLike interface, BridgeClientError
  tests/
    config.test.ts
    client.test.ts
    actor.test.ts
    inbox.test.ts
    inbox-queue.test.ts
    streamer.test.ts
    discovery.test.ts
    index.test.ts
    integration/
      bridge-integration.test.ts
```

### Architecture Diagram

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

### Data Flow

```
session_start
  ├─ loadConfig() → BridgeConfig
  ├─ (optional) discoverGroups() via daemon groups() API
  ├─ ensureRegistered() → actor ID (idempotent)
  ├─ InboxStreamer.start() → events_stream (TCP push)
  │   └─ on disconnect: exponential backoff, then onFallback
  │       └─ InboxPoller.start() → periodic inbox_list polling
  ├─ registerTools() → cccc_send, cccc_reply, cccc_whoami, cccc_list_actors, cccc_rename
  ├─ registerCommands() → /cccc-status, /cccc-config, /cccc-actors, /cccc-send, /cccc-inbox, /cccc-rename
  └─ InboxQueue delivers buffered messages via pi.sendMessage()

session_shutdown
  └─ streamer.stop(), poller.stop(), client.disconnect()
```

### Key Classes

| Class              | File             | Role                                                                                                                                                      |
| ------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CCCCBridgeClient` | `client.ts`      | Wraps `cccc-sdk` TCP client with typed methods and error handling. Supports dependency injection for tests.                                               |
| `InboxStreamer`    | `streamer.ts`    | Long-lived `events_stream` consumer via async generator. Reconnects with exponential backoff (1s, 2s, 4s, 8s, 30s). Calls `onFallback` after max retries. |
| `InboxPoller`      | `inbox.ts`       | Polling fallback using `inbox_list` on a configurable interval. Deduplicates by event ID, marks read after delivery.                                      |
| `InboxQueue`       | `inbox-queue.ts` | Buffers incoming events with debouncing. Batches multiple messages before delivery to avoid flooding the conversation.                                    |

### Graceful Degradation

- **Daemon unreachable**: Per-group connection failure is caught and logged; other groups continue. If `ctx.hasUI`, a toast notification is shown.
- **Stream disconnect**: Exponential backoff (1s–30s), then transparent fallback to polling. Polling inherits the stream's deduplication set for continuity.
- **No groups configured**: The extension does nothing. Pi Agent runs normally and the extension is inert.
- **Sub-agent mode**: Ephemeral registration only — no persistent connections — so spawned agents don't leave dangling sockets.
- **Actor name collision**: `ensureRegistered()` handles `NameAlreadyExists` errors gracefully — the actor re-connects on restart without error.

---

## Testing

This project uses a 4-layer testing strategy. See [docs/testing.md](docs/testing.md) for full details.

### Layer 1: Unit Tests

Fast, isolated tests with dependency injection. No daemon required.

```bash
cd packages/extension
vp test           # 229 tests, 8 test files
vp check          # tollgate: format + lint + type-check
```

### Layer 2: Integration Tests

Tests the `CCCCBridgeClient` against a live CCCC daemon over TCP. Automatically skip when no daemon is available.

```bash
CCCC_DAEMON_HOST=192.168.7.163 pnpm test:integration
```

### Layer 3: E2E Agent Tests

Tests the extension inside a real Pi Agent session using `herdr`. See [docs/testing.md](docs/testing.md#layer-3-e2e-agent-tests) for the manual procedure.

### Layer 4: Cross-Harness Tests

Tests the full round-trip between OMP agents and Pi Agent sessions through the CCCC daemon.

### Running the Full Suite

```bash
cd packages/extension

# Format, lint, type-check
vp check

# Unit tests (fast, no daemon needed)
vp test

# Integration tests (requires daemon)
CCCC_DAEMON_HOST=192.168.7.163 pnpm test:integration

# All tests
vp test && CCCC_DAEMON_HOST=192.168.7.163 pnpm test:integration
```

---

## Troubleshooting

### "No model selected"

The Pi Agent session needs a model provider configured. Check that `~/.omp/agent/models.yml` has a provider section (OpenAI, omniroute, etc.) and that the provider is reachable.

```
# Example provider config
providers:
  omniroute:
    baseUrl: http://192.168.7.163:20128/v1
    apiKey: sk-...
```

### "Connection refused"

The CCCC daemon at `CCCC_DAEMON_HOST:CCCC_DAEMON_PORT` is unreachable.

```bash
# Test TCP connectivity
nc -zv 192.168.7.163 9765

# Check daemon health (if available)
curl -s http://192.168.7.163:8848/api/health
```

Verify the daemon is running in its Docker container on the host machine and that no firewall is blocking the port.

### "Name already exists"

Actor registration is idempotent — this message is normal on restart and is handled gracefully. The extension calls `ensureRegistered()` which catches `NameAlreadyExists` errors.

If you see unexpected behavior, clear the state file to force fresh actor identity resolution:

```bash
rm ~/.pi/agent/extensions/cccc-bridge-state.json
```

### Messages not arriving

1. **Check connection status** — Run `/cccc-status` in the prompt. Verify you see `State: connected` and the correct group ID.
2. **Verify group ID** — Run `/cccc-config` to confirm the group ID. Check the group exists in the [CCCC Web UI](http://192.168.7.163:8848/ui/).
3. **Check sender addressing** — Ensure the sender's `to` field addresses your actor ID. Messages addressed to `@all` or your specific actor ID are delivered to your inbox.
4. **Auto-discovery mismatch** — If using auto-discovery, verify the group's scoped path matches your cwd or git repo root.
5. **Event stream resilience** — If the event stream is failing silently, the extension falls back to polling after ~45s. Watch for `[cccc-bridge]` console logs.
6. **Check daemon logs** — Verify the actor registration and event stream subscription appear in the daemon's log.

### Can't see slash commands

Make sure the extension is properly symlinked:

```bash
ls -la ~/.pi/agent/extensions/cccc-bridge   # must point to packages/extension
```

If the symlink is missing, re-create it:

```bash
ln -s "$PWD/packages/extension" ~/.pi/agent/extensions/cccc-bridge
```

If the symlink exists but commands don't appear, verify the extension loads at startup by checking for `[cccc-bridge]` messages in the session output.

### Messages not appearing in Web UI after agent responds

The extension delivers incoming messages into the conversation — it does **not** intercept the agent's response. Sending replies is handled separately through the agent's CCCC tools (`cccc_send`, `cccc_reply`). Verify that the tools are registered (the agent should have access to them automatically) and that the agent model can call them correctly.

### pi-link "Cannot find module 'ws'"

The built-in `pi-link.ts` extension requires the `ws` WebSocket module which may not be installed. Start pi with only the CCCC bridge:

```bash
pi -ne -e ~/.pi/agent/extensions/cccc-bridge
```

### Integration tests hang or timeout

Check daemon reachability and group existence:

```bash
nc -zv 192.168.7.163 9765
cccc group show g_c8878957bd2c
```

---

## Development

### Branch Workflow

All work happens in branches off `main`. Never edit files directly in the main checkout — use an isolated git worktree:

```bash
git worktree add .worktrees/<branch-name> -b <branch-name>
cd .worktrees/<branch-name>
pnpm install
```

### TDD Requirement

This project follows test-driven development. Every feature starts with a failing test:

```typescript
import { expect, test, describe, beforeEach } from "vite-plus/test";

describe("myFeature", () => {
  test("behaves correctly", () => {
    // ...
  });
});
```

### Contribution Checklist

1. Read `AGENTS.md` for the full development workflow
2. Create a branch from `main` (`feature/`, `fix/`, `chore/`, `docs/`)
3. Write tests first (red), then implementation (green), then refactor
4. Run `vp check` — must pass before any commit
5. Commit with conventional commit message (`feat:`, `fix:`, `chore:`, `docs:`)
6. Push branch, create PR against `main`, get review approval
7. Merge (squash or rebase per PR context), delete branch, sync issue state

### Commands

| Command                 | Purpose                                            |
| ----------------------- | -------------------------------------------------- |
| `vp check`              | Tollgate: oxfmt (format) + oxlint + tsc type check |
| `vp check --fix`        | Auto-format and auto-fix lint                      |
| `vp test`               | Run unit tests with vitest                         |
| `vp lint`               | Lint with oxlint                                   |
| `vp format`             | Format with oxfmt                                  |
| `vp pack`               | Build extension                                    |
| `pnpm test:integration` | Run integration tests (requires daemon)            |

### Project Structure

```
.                              # repo root
  packages/extension/          # extension source
    package.json               # deps + "pi.extensions" manifest
    tsconfig.json              # strict TypeScript config
    src/
      index.ts                 # entry point (default export factory)
      client.ts                # CCCC daemon client wrapper
      actor.ts                 # actor registration / identity
      inbox.ts                 # inbox polling and delivery
      inbox-queue.ts           # debounced batching
      streamer.ts              # event stream consumer
      config.ts                # env/config reading
      types.ts                 # shared types
  docs/
    idea.md                    # original design doc
    testing.md                 # testing strategy
  AGENTS.md                    # agent workflow instructions
```
