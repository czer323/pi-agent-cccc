#!/usr/bin/env bash
# =============================================================================
# herdr-e2e.sh — E2E test harness for CCCC bridge extension
#
# Spawns a headless pi-agent session via herdr with the CCCC bridge extension
# loaded, then verifies the full message round-trip: actor registration, CLI→
# agent message delivery, agent→group reply via cccc_send tool, cccc_whoami,
# and cccc_list_actors. Cleans up the agent on completion or failure.
#
# Prerequisites:
#   - herdr installed and on PATH
#   - pi (pi-coding-agent) installed and on PATH
#   - CCCC bridge extension symlinked at ~/.pi/agent/extensions/cccc-bridge
#   - CCCC daemon running at 192.168.7.163:9765
#   - Target group g_c8878957bd2c exists on the daemon
#
# Usage:
#   ./tests/e2e/herdr-e2e.sh
#
# Returns:
#   0 — all tests passed
#   1 — one or more tests failed
# =============================================================================

set -euo pipefail

# ---- Configuration ----------------------------------------------------------
AGENT_NAME="e2e-test"
AGENT_CWD="/tmp/e2e-test"
CCCC_GROUP="g_c8878957bd2c"
CCCC_DAEMON_HOST="192.168.7.163"
EXTENSION_PATH="${HOME}/.pi/agent/extensions/cccc-bridge"
TIMESTAMP="$(date +%s)"
UNIQUE_TAG="E2E${TIMESTAMP}"
# Dedicated workspace for the test agent — avoids closing the caller's tab
TEST_WORKSPACE=""

PASS_COUNT=0
FAIL_COUNT=0

# ---- Helpers ----------------------------------------------------------------

pass() {
  local label="$1"
  echo "  PASS  ${label}"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  local label="$1"
  local detail="${2:-}"
  echo "  FAIL  ${label}${detail:+ — ${detail}}"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

summary() {
  echo ""
  echo "============================================"
  echo "  Results: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"
  echo "============================================"
  if [ "${FAIL_COUNT}" -gt 0 ]; then
    return 1
  fi
}

# Call the CCCC daemon over TCP with an NDJSON request.
# Usage: daemon_call <op> <json-args>
# Example: daemon_call actor_list '{"group_id": "g_..."}'
# Prints the JSON response to stdout.
daemon_call() {
  local op="$1"
  shift
  local args="$1"
  python3 -c "
import socket, json, sys
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.settimeout(10)
s.connect(('${CCCC_DAEMON_HOST}', 9765))
req = json.dumps({'v': 1, 'op': '${op}', 'args': ${args}}) + '\n'
s.sendall(req.encode())
data = b''
while True:
    try:
        chunk = s.recv(4096)
        if not chunk: break
        data += chunk
        if b'\n' in data: break
    except socket.timeout:
        break
s.close()
result = json.loads(data.decode().strip())
print(json.dumps(result))
" 2>/dev/null
}
cleanup() {
  local exit_code=$?
  echo ""
  echo "--- Cleanup: stopping agent ---"
  # Close the dedicated workspace (kills the agent process inside it)
  if [ -n "${TEST_WORKSPACE}" ]; then
    herdr workspace close "${TEST_WORKSPACE}" 2>/dev/null || true
  fi
  # Brief pause to let daemon process the removal
  sleep 1
  # Verify actor removed — this is informational, not a test gate
  if daemon_call actor_list '{"group_id": "'${CCCC_GROUP}'"}' | grep -q "${AGENT_NAME}"; then
    echo "  [warn] Actor '${AGENT_NAME}' still visible after stop; may need manual cleanup"
  else
    echo "  Actor '${AGENT_NAME}' removed from group"
  fi
  echo "--- Cleanup complete ---"
  # If we were killed by a test failure, re-print the summary
  if [ "${exit_code}" -ne 0 ] && [ "${FAIL_COUNT}" -eq 0 ]; then
    # Script error (set -e) rather than test failure
    echo "[FATAL] Script terminated unexpectedly (exit code ${exit_code})"
  fi
}
trap cleanup EXIT

# ---- Test Functions ---------------------------------------------------------

test_setup() {
  echo ""
  echo "============================================"
  echo "  Setup: Starting herdr agent"
  echo "============================================"

  # Ensure working directory exists
  mkdir -p "${AGENT_CWD}"

  # Create a dedicated workspace so cleanup doesn't close the caller's tab
  local ws_output
  ws_output="$(herdr workspace create --cwd "${AGENT_CWD}" --label "e2e-test-ws" 2>&1)"
  TEST_WORKSPACE="$(echo "${ws_output}" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['workspace']['workspace_id'])" 2>/dev/null || echo "")"
  if [ -z "${TEST_WORKSPACE}" ]; then
    echo "  [warn] Could not create dedicated workspace; falling back to current workspace"
    # Try to extract workspace from the error (name_taken means it already exists)
    TEST_WORKSPACE="$(echo "${ws_output}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error',{}).get('candidates',[''])[0].split()[0].split('=')[1] if 'candidates' in d.get('error',{}) else '')" 2>/dev/null || echo "")"
  fi
  echo "  Workspace: ${TEST_WORKSPACE}"

  echo "  Starting pi-agent in workspace ${TEST_WORKSPACE}..."

  herdr agent start "${AGENT_NAME}" \
    --cwd "${AGENT_CWD}" \
    --workspace "${TEST_WORKSPACE}" \
    --env "CCCC_GROUP_ID=${CCCC_GROUP}" \
    --env "CCCC_DAEMON_HOST=${CCCC_DAEMON_HOST}" \
    -- \
    pi -ne -e "${EXTENSION_PATH}"

  echo "  Agent start command issued. Waiting for idle state..."
}

test_agent_ready() {
  echo ""
  echo "============================================"
  echo "  Test: Agent becomes ready"
  echo "============================================"

  # Wait for the agent to reach idle state (extension loaded, registered)
  if herdr agent wait "${AGENT_NAME}" --status idle --timeout 30000; then
    pass "Agent reached idle state"
  else
    fail "Agent did not reach idle state within 30s"
    # Dump output for diagnostics
    herdr agent read "${AGENT_NAME}" --lines 50 2>/dev/null || true
    return 1
  fi

  # Verify the extension banner is visible in agent output
  local agent_output
  agent_output="$(herdr agent read "${AGENT_NAME}" --lines 50 2>/dev/null || true)"
  if echo "${agent_output}" | grep -q 'CCCC bridge connected'; then
    pass "Extension loaded: 'CCCC bridge connected' seen in output"
  else
    fail "Extension load message not found in agent output"
    echo "  Agent output (first 50 lines):"
    echo "${agent_output}" | head -50
    return 1
  fi
}

test_actor_registration() {
  echo ""
  echo "============================================"
  echo "  Test 1: Actor registration"
  echo "============================================"

  # Check that the e2e-test actor appears in the CCCC group roster.
  # Query the daemon directly via TCP (cccc CLI fails with group_not_found
  # when the daemon is remote).
  local actor_output
  actor_output="$(daemon_call actor_list '{"group_id": "'${CCCC_GROUP}'"}' 2>/dev/null || true)"

  if echo "${actor_output}" | grep -q "${AGENT_NAME}"; then
    pass "Actor '${AGENT_NAME}' found in CCCC group roster"
  else
    fail "Actor '${AGENT_NAME}' not found in CCCC group roster"
    echo "  Daemon response:"
    echo "${actor_output}" | python3 -m json.tool 2>/dev/null || echo "${actor_output}"
    return 1
  fi
}


test_message_delivery() {
  echo ""
  echo "============================================"
  echo "  Test 2: Message delivery (Daemon → Agent)"
  echo "============================================"

  local test_msg="E2E test: can you hear me? ${UNIQUE_TAG}"

  # Send a message via daemon TCP API
  echo "  Sending: ${test_msg}"
  daemon_call send '{"group_id": "'${CCCC_GROUP}'", "by": "e2e-test", "text": "'"${test_msg}"'", "to": ["@all"]}' >/dev/null 2>&1 || true

  # Wait for agent to process (it goes idle after handling the message)
  herdr agent wait "${AGENT_NAME}" --status idle --timeout 30000 || true

  # Read agent output for the message
  local agent_output
  agent_output="$(herdr agent read "${AGENT_NAME}" --lines 20 2>/dev/null || true)"

  if echo "${agent_output}" | grep -q "${UNIQUE_TAG}"; then
    pass "Agent received daemon-sent message"
  else
    # The agent may not have line-buffered the full input yet.
    # Try reading more lines.
    agent_output="$(herdr agent read "${AGENT_NAME}" --lines 100 2>/dev/null || true)"
    if echo "${agent_output}" | grep -q "${UNIQUE_TAG}"; then
      pass "Agent received daemon-sent message (after extended read)"
    else
      fail "Agent did not receive daemon-sent message"
      echo "  Agent output:"
      echo "${agent_output}" | tail -30
      return 1
    fi
  fi
}

test_agent_reply() {
  echo ""
  echo "============================================"
  echo "  Test 3: Agent reply via cccc_send tool"
  echo "============================================"

  local reply_marker="E2E_REPLY_OK_${UNIQUE_TAG}"

  # Instruct the agent to use its cccc_send tool
  echo "  Prompting agent to send: ${reply_marker}"
  herdr agent send "${AGENT_NAME}" \
    "Use the cccc_send tool to send a message to the group saying ${reply_marker}"

  # Wait for the agent to finish processing the prompt
  herdr agent wait "${AGENT_NAME}" --status idle --timeout 60000 || true

  # Check the CCCC daemon ledger for the reply via TCP API
  sleep 2
  local daemon_ledger
  daemon_ledger="$(daemon_call ledger_tail '{"group_id": "'${CCCC_GROUP}'", "limit": 10}' 2>/dev/null || true)"

  if echo "${daemon_ledger}" | grep -q "${reply_marker}"; then
    pass "Agent reply '${reply_marker}' received by CCCC group"
  else
    fail "Agent reply not found in CCCC group ledger"
    echo "  Daemon ledger response:"
    echo "${daemon_ledger}" | python3 -m json.tool 2>/dev/null || echo "${daemon_ledger}"
    echo ""
    echo "  Agent output after send:"
    herdr agent read "${AGENT_NAME}" --lines 50 2>/dev/null || true
    return 1
  fi
}

test_whoami() {
  echo ""
  echo "============================================"
  echo "  Test 4: cccc_whoami tool"
  echo "============================================"

  herdr agent send "${AGENT_NAME}" \
    "Use the cccc_whoami tool and tell me what it returns"

  herdr agent wait "${AGENT_NAME}" --status idle --timeout 60000 || true

  local agent_output
  agent_output="$(herdr agent read "${AGENT_NAME}" --lines 50 2>/dev/null || true)"

  # The whoami tool returns "Actor ID: <id>\nGroups: <group>"
  if echo "${agent_output}" | grep -iq 'actor'; then
    pass "cccc_whoami response contains actor reference"
  else
    fail "No actor reference found in whoami output"
    echo "  Agent output:"
    echo "${agent_output}"
    return 1
  fi

  if echo "${agent_output}" | grep -q "${CCCC_GROUP}"; then
    pass "cccc_whoami response mentions target group"
  else
    fail "Target group not found in whoami output"
    echo "  Agent output:"
    echo "${agent_output}"
    return 1
  fi
}

test_list_actors() {
  echo ""
  echo "============================================"
  echo "  Test 5: cccc_list_actors tool"
  echo "============================================"

  herdr agent send "${AGENT_NAME}" \
    "Use the cccc_list_actors tool and tell me what it returns"

  herdr agent wait "${AGENT_NAME}" --status idle --timeout 60000 || true

  local agent_output
  agent_output="$(herdr agent read "${AGENT_NAME}" --lines 50 2>/dev/null || true)"

  if echo "${agent_output}" | grep -iq 'actor'; then
    pass "cccc_list_actors response contains actor references"
  else
    fail "No actor references found in list_actors output"
    echo "  Agent output:"
    echo "${agent_output}"
    return 1
  fi

  if echo "${agent_output}" | grep -iqE '(running|idle)'; then
    pass "cccc_list_actors response contains actor state information"
  else
    fail "No state information in list_actors output"
    echo "  Agent output:"
    echo "${agent_output}"
    return 1
  fi
}

# ---- Main -------------------------------------------------------------------

main() {
  echo "============================================"
  echo "  CCCC Bridge E2E Test Suite"
  echo "  Timestamp: ${TIMESTAMP}"
  echo "  Group:     ${CCCC_GROUP}"
  echo "============================================"

  test_setup
  test_agent_ready
  test_actor_registration
  test_message_delivery
  test_agent_reply
  test_whoami
  test_list_actors

  summary
}

main
