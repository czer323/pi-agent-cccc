# E2E Tests: CCCC Bridge Extension via herdr

This directory contains end-to-end tests that verify the CCCC bridge extension
works inside a live pi-agent session spawned through `herdr`.

## Prerequisites

Before running the E2E tests, ensure the following are in place:

1. **herdr** — installed and on `PATH`
2. **pi-agent** — installed and on `PATH` (the `pi` command)
3. **CCCC bridge extension** — symlinked at `~/.pi/agent/extensions/cccc-bridge`

   ```bash
   ln -sf "$PWD/packages/extension" ~/.pi/agent/extensions/cccc-bridge
   ```

4. **CCCC daemon** — running at `192.168.7.163:9765` (or override via env vars)
5. **cccc CLI** — on `PATH`, authenticated
6. **Target group** — `g_c8878957bd2c` must exist on the daemon

## Running

```bash
cd ~/projects/pi-agent-cccc

# Full test suite
./tests/e2e/herdr-e2e.sh
```

All tests must pass (exit 0). If any test fails, the script exits non-zero.

## What It Tests

| #   | Test               | What It Verifies                                           |
| --- | ------------------ | ---------------------------------------------------------- |
| 1   | Actor registration | Extension connects to daemon, registers during startup     |
| 2   | Message delivery   | CLI-sent message arrives in the agent's conversation loop  |
| 3   | Agent reply        | Agent uses `cccc_send` tool to send a message to the group |
| 4   | cccc_whoami        | Tool returns the agent's actor ID and connected groups     |
| 5   | cccc_list_actors   | Tool returns the group roster with actor states            |

## Cleanup

The script registers an `EXIT` trap that stops the herdr agent and verifies
the actor is removed from the CCCC group, even if a test fails.

For manual cleanup:

```bash
herdr agent stop e2e-test
```

## Environment Variables

| Variable           | Default          | Description                |
| ------------------ | ---------------- | -------------------------- |
| `CCCC_DAEMON_HOST` | `192.168.7.163`  | Daemon TCP host            |
| `CCCC_DAEMON_PORT` | `9765`           | Daemon TCP port            |
| `CCCC_GROUP_ID`    | `g_c8878957bd2c` | Target group for the tests |

## Adding a New Test

1. Add a `test_<name>()` function to `herdr-e2e.sh`
2. Follow the pattern: send/do something, wait for idle, read output, grep for expected text
3. Call `pass` or `fail` based on the result
4. Call the function from `main()`

## Troubleshooting

**"herdr agent start" fails** — check that `pi` is on PATH and the extension is
symlinked. Run the start command manually to see stderr:

```bash
herdr agent start e2e-test --cwd /tmp/e2e-test \
  --env CCCC_GROUP_ID=g_c8878957bd2c \
  --env CCCC_DAEMON_HOST=192.168.7.163 \
  -- pi -ne -e ~/.pi/agent/extensions/cccc-bridge
```

**"cccc: command not found"** — ensure the CCCC CLI is installed and on PATH.

**Agent times out waiting for idle** — the extension may have failed to connect.
Check agent output:

```bash
herdr agent read e2e-test --lines 50
```

**Daemon unreachable** — verify connectivity:

```bash
nc -zv 192.168.7.163 9765
```
