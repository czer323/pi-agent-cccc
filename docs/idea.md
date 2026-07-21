# Pi Agent ↔ CCCC Bridge Plugin

## What

A Pi Agent extension that connects to a running CCCC daemon and bridges external messages
into the agent's conversation loop — so the agent receives and responds to CCCC messages
in real-time without manual polling.

## Why

CCCC ("Coordinate your coding agents like a group chat") is a daemon-based multi-agent
coordination kernel. It provides MCP tools for agents to interact with groups, but its
delivery model is pull-based for non-spawned agents:

```
Message written to ledger
  ↓
Daemon parses the "to" field
  ↓
For each target actor:
  ├─ PTY running → inject into terminal
  └─ Otherwise → leave in inbox
  ↓
Wait for agent to call mark_read
```

Pi Agent (and its derivatives: Hermes, Oh-My-Pi, OpenCode) connects to CCCC as an
external agent via MCP tools. The daemon has no mechanism to push messages into
the agent's conversation — messages sit in the inbox until the agent polls.

Currently the only way to receive messages is to manually call `cccc_inbox_list`
within a conversation turn. This is non-deterministic and unreliable.

## Goal

A Pi Agent extension — one TypeScript file in `~/.pi/agent/extensions/` — that:

1. **Connects** to the CCCC daemon via TCP at session start
2. **Subscribes** to the daemon's real-time event stream (`events_stream`)
3. **Buffers** incoming `chat.message` events addressed to this agent
4. **Injects** them into the conversation as agent turns
5. **Sends** replies back through the daemon so they appear in the CCCC Web UI

The agent in any Pi Agent session becomes a full participant in the CCCC group —
messages arrive in real-time, the agent responds, and replies are visible to all
group members (including the Web UI and other agents).

## Architecture

```
┌──────────────┐     TCP/9765      ┌───────────────┐
│  CCCC Daemon │◄─────────────────│  Pi Agent       │
│  (TrueNAS)   │   events_stream  │  Extension      │
│              │   + send/reply   │  (cccc-bridge)  │
│  group:      │                  │                 │
│  ccccc-group │                  │  hooks into:    │
│  actor:      │                  │  session_start  │
│  opencode-   │                  │  before_agent_  │
│  agent       │                  │  start          │
│              │                  │  agent_settled  │
│  Web UI      │                  │  session_       │
│  :8848       │                  │  shutdown       │
└──────────────┘                  └─────────────────┘
```

### CCCC Daemon Side

- Single instance running in Docker on TrueNAS, managed by Arcane
- Web UI at `http://192.168.7.163:8848/ui/`
- Daemon IPC (newline-delimited JSON over TCP) at `192.168.7.163:9765`
- Group ID: `g_c8878957bd2c`
- Actor ID for this agent: `opencode-agent` (registered as `web_model` runtime,
  headless runner — needs to be changed to something appropriate for Pi Agent)
- Daemon version: 0.4.31 (protocol: IPC v1)

### Pi Agent Extension Side

The extension should use the Pi Agent extension API:

```
~/.pi/agent/extensions/cccc-bridge.ts
```

Key imports:

- `@earendil-works/pi-coding-agent` — `ExtensionAPI`, `ExtensionContext`
- `node:net` — for TCP connection to daemon

Relevant events (from `packages/coding-agent/docs/extensions.md`):

| Event                | When                    | Purpose                                                       |
| -------------------- | ----------------------- | ------------------------------------------------------------- |
| `session_start`      | Session starts/starts   | Open TCP connection to daemon, subscribe to events_stream     |
| `before_agent_start` | Before each turn        | Check for buffered CCCC messages and inject via event.message |
| `agent_settled`      | Agent finishes all work | Mark messages read, continue event stream subscription        |
| `session_shutdown`   | Session ends            | Close connection, clean up                                    |

## CCCC Daemon IPC Protocol

Daemon IPC is newline-delimited JSON over TCP:

**Request:**

```json
{"v": 1, "op": "<operation>", "args": {...}}
```

**Response:**

```json
{"v": 1, "ok": true/false, "result": {...}, "error": null}
```

### Key Operations

#### events_stream

Subscribe to real-time ledger events. Opens a persistent TCP connection; events are
pushed as they happen (30s heartbeat). Filtered by group_id, kinds.

```
op: "events_stream"
args: {
  "group_id": "g_c8878957bd2c",
  "by": "opencode-agent",
  "kinds": ["chat.message"]
}
```

Response: continuous stream of NDJSON event objects.

#### send

Send a chat message.

```
op: "send"
args: {
  "group_id": "g_c8878957bd2c",
  "actor_id": "opencode-agent",
  "by": "opencode-agent",
  "text": "...",
  "to": ["user"]
}
```

#### reply

Reply to a specific message.

```
op: "reply"
args: {
  "group_id": "g_c8878957bd2c",
  "actor_id": "opencode-agent",
  "by": "opencode-agent",
  "reply_to": "<event_id>",
  "text": "..."
}
```

#### inbox_list

Check for unread messages (fallback/initial sync).

```
op: "inbox_list"
args: {
  "group_id": "g_c8878957bd2c",
  "actor_id": "opencode-agent",
  "limit": 50,
  "kind_filter": "all"
}
```

#### inbox_mark_read

Mark a message as read.

```
op: "inbox_mark_read"
args: {
  "group_id": "g_c8878957bd2c",
  "actor_id": "opencode-agent",
  "event_id": "<event_id>"
}
```

### Connection Details

TCP to `192.168.7.163:9765`. Each request is a separate TCP connection
(request → response → close), except `events_stream` which is persistent.

For `events_stream`, the daemon pushes events over the open socket. To handle this
from a Pi Agent extension, either:

- Use a background socket connection with an async iterator
- Poll via `inbox_list` as a simpler fallback (less real-time, but deterministic)

## CCCC SDK Reference

The `cccc-sdk` package (`pip install cccc-sdk` or `npm install cccc-sdk`) provides
a proper client for the daemon IPC. The Python SDK has examples showing the pattern:

- `python/examples/stream.py` — subscribes to events_stream and prints events
- `python/examples/auto_ack_attention.py` — watches for attention messages, auto-ACKs
- `python/examples/werewolf/` — full multi-agent game on top of events_stream

Repo: https://github.com/ChesterRa/cccc-sdk (cloned at `~/git/cccc-sdk/`)

The SDK is published on npm as `cccc-sdk`, so it can be used as a dependency
of the Pi Agent extension.

## Related Files

| Path                                                               | Description                                                 |
| ------------------------------------------------------------------ | ----------------------------------------------------------- |
| `~/git/cccc-sdk/`                                                  | CCCC SDK repo (Python + TypeScript)                         |
| `~/git/cccc-sdk/python/examples/stream.py`                         | events_stream subscription example                          |
| `~/git/cccc-sdk/python/examples/auto_ack_attention.py`             | Auto-ACK pattern                                            |
| `~/git/cccc-sdk/python/examples/werewolf/`                         | Full game using events_stream                               |
| `~/git/pi/packages/coding-agent/docs/extensions.md`                | Pi Agent extension API docs                                 |
| `~/git/herdr/src/integration/assets/opencode/herdr-agent-state.js` | Example OpenCode plugin (session state reporting to herdr)  |
| `~/.pi/agent/extensions/pi-link.ts`                                | Existing Pi Agent extension (inter-terminal WebSocket chat) |
| `~/git/cccc/`                                                      | CCCC core source                                            |
| `~/git/cccc/docs/standards/CCCC_DAEMON_IPC_V1.md`                  | Daemon IPC spec                                             |
| `~/git/cccc/docs/standards/CCCS_V1.md`                             | Collaboration protocol spec                                 |

## Open Questions

1. **Runtime registration**: The agent is currently registered as `web_model` runtime
   in CCCC. Should it be `custom` or some other runtime type for Pi Agent?

2. **Injection mechanism**: Should the extension use `before_agent_start` to inject
   buffered messages as context, or use `ctx.sendUserMessage()` to trigger new turns?

3. **Event stream vs polling**: `events_stream` provides real-time push but requires
   a persistent TCP connection inside the Pi Agent process (not ideal for extensions
   per the docs: "Do not start background resources from the factory"). Polling via
   `inbox_list` at each turn boundary is simpler and safer. Which approach?

4. **Multi-agent**: If multiple Pi Agents connect to the same CCCC group, each needs
   its own inbox. How does the extension identify which messages belong to it?
   (CCCC routes by `to` field containing the actor_id.)

5. **Delivery confirmation**: After the agent processes a message, the extension
   should call `inbox_mark_read` so the daemon tracks delivery state.

## Next Steps

This document is a high-level idea handoff. A follow-up agent should:

1. Review all referenced files and docs
2. Break down into concrete implementation tasks
3. Design the extension API surface
4. Implement the TypeScript extension
5. Test against the running CCCC daemon at 192.168.7.163
