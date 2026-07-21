# Testing Strategy

The CCCC Bridge extension uses a 4-layer testing strategy to ensure correctness
at every integration level.

## Layer 1: Unit Tests

**Location:** `packages/extension/tests/` (7 files, 115+ tests)

**Purpose:** Verify individual modules in isolation with dependency injection.

Each source module has a corresponding test file that mocks its dependencies
(using `vi.mock`) and tests error paths, edge cases, and success flows. The
`CCCCBridgeClient` accepts an optional `CCCCClientLike` stub in its constructor
for zero-daemon testing.

**Run:**

```bash
cd packages/extension
vp test        # all unit tests
```

**Key patterns:**

- Mock the SDK client via `CCCCClientLike` interface
- Test `BridgeClientError` wrapping for all SDK failures
- Test "not connected" guard on every method
- Use `vi.hoisted` for shared mock functions
- Use `beforeEach` for mock reset

## Layer 2: Integration Tests

**Location:** `packages/extension/tests/integration/bridge-integration.test.ts`

**Purpose:** Test the `CCCCBridgeClient` against a LIVE CCCC daemon over TCP.

These tests exercise the real daemon protocol — actor registration, inbox
polling, group discovery, and actor removal. They use the production
`CCCCBridgeClient` (no mocks) and the `cccc` CLI for sending test messages.

### Prerequisites

- A running CCCC daemon (default: `192.168.7.163:9765`)
- `cccc` CLI available on `PATH`
- Environment variables (see below)

### Environment Variables

| Variable           | Required | Default         | Description                 |
| ------------------ | -------- | --------------- | --------------------------- |
| `CCCC_DAEMON_HOST` | **Yes**  | —               | Daemon TCP host             |
| `CCCC_DAEMON_PORT` | No       | `9765`          | Daemon TCP port             |
| `CCCC_GROUP_ID`    | No       | auto-discovered | Target group for test actor |

When `CCCC_DAEMON_HOST` is not set, all integration tests are skipped gracefully
(no-op). This allows CI and local dev to run the full unit suite without a
daemon.

### Run

```bash
cd packages/extension

# With a running daemon:
CCCC_DAEMON_HOST=192.168.7.163 pnpm test:integration

# Integrations are excluded from the default test run:
vp test          # unit tests only
```

### What It Tests

1. **Actor registration** — `client.registerActor()` with the real daemon
2. **Message delivery** — CLI sends a broadcast message; bridge client polls
   inbox until the message is found (with retry + timeout)
3. **Group discovery** — `client.groups()` and `client.groupShow()`
4. **Actor removal** — `client.actorRemove()` cleans up the test actor
5. **Graceful skip** — All tests are guarded by `CCCC_DAEMON_HOST`

### Cleanup

The `afterAll` hook removes the test actor on completion, even if some
intermediate test failed. The test actor ID includes a random suffix
(`test-int-<hex>`) to allow concurrent runs without collision.

## Layer 3: E2E Agent Tests

**Purpose:** Verify the extension works inside a real Pi Agent session.

An automated E2E test uses `herdr` to spawn a headless Pi Agent instance with
the CCCC bridge extension loaded:

```bash
# Conceptual workflow:
herdr spawn pi-agent \
  --extension ~/.pi/agent/extensions/cccc-bridge \
  --env CCCC_GROUP_ID=g_<group> \
  --headless

# Then from another terminal, send a message via the CCCC CLI:
cccc send --group g_<group> --text "E2E test message"

# Verify the Pi Agent session received the message
herdr logs <session-id> | grep "E2E test message"

# Clean up
herdr stop <session-id>
```

### Prerequisites

- `herdr` installed and configured
- Pi Agent installed with the extension symlinked
- A running CCCC daemon and an existing test group

### Key Checks

- Extension loads without errors during `session_start`
- Actor is registered with the daemon
- Messages sent via CLI arrive in the agent's conversation loop
- `session_shutdown` removes the actor

### Future Automation

A formal E2E test script can be added at `tests/e2e/` once herdr exposes a
stable headless API for automated assertions. For now, the procedure above
documents the manual verification path.

## Layer 4: Cross-Harness Tests (OMP ↔ Pi Agent)

**Purpose:** Verify the extension correctly bridges messages between
OmniRoute Model Platform (OMP) agents and Pi Agent sessions.

This tests the full round-trip:

1. An OMP agent sends a message to a CCCC group
2. The Pi Agent extension receives it via the event stream
3. Pi Agent processes the message (generates a response)
4. The response is sent back through the CCCC daemon (via MCP tools)
5. The OMP agent observes the reply

### Architecture

```
OMP Agent ──send──► CCCC Daemon ──events_stream──► Pi Agent Extension
   ▲                                                    │
   │                                                    │ pi.sendMessage
   │                                                    ▼
   │                                              Pi Agent Session
   │                                                    │
   └──────── cccc_send MCP tool ◄────── reply ◄─────────┘
```

### Prerequisites

- OMP agent with CCCC MCP tools configured (`mcp__cccc_*`)
- Pi Agent session with the bridge extension loaded
- Both agents joined to the same CCCC group

### Running the Test

```bash
# Terminal 1: Start Pi Agent with the extension
CCCC_GROUP_ID=g_<group> pi -ne -e ~/.pi/agent/extensions/cccc-bridge

# Terminal 2: OMP sends a message using hub or MCP tool
# (The message arrives in Pi Agent's conversation loop)

# Terminal 3: Monitor the group ledger for replies
cccc tail --group g_<group>
```

### Key Checks

- Messages flow bidirectionally
- Actor identity is preserved (OMP agents and Pi Agent actors are distinct)
- No duplicate delivery or missed messages
- Event stream reconnection works if the daemon restarts

## CI Integration

The project's CI pipeline runs:

```yaml
# .github/workflows/ci.yml (conceptual)
steps:
  - run: vp check # format + lint + type-check
  - run: vp test # unit tests (Layer 1)
  - run: pnpm test:integration # integration tests (Layer 2, skips if no daemon)
```

Layer 3 and Layer 4 tests are manual or run in dedicated environments with a
live daemon and Pi Agent/OMR sessions.

## Troubleshooting

### Integration tests hang or timeout

Check that the daemon is reachable:

```bash
nc -zv 192.168.7.163 9765
```

Verify the group exists:

```bash
cccc group show g_<groupid>
```

### Tests pass locally but fail in CI

Integration tests require `CCCC_DAEMON_HOST` to be set. In CI, either:

- Provide a daemon endpoint as a CI secret
- Leave it unset (tests skip automatically)

### Unit tests fail after adding new functionality

Ensure:

1. The `CCCCClientLike` interface in `src/types.ts` includes any new SDK methods
2. Mock implementations in test files match the new interface
3. `vp check` passes before committing

## Running the Full Suite

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
