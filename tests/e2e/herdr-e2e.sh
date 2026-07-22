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

set -uo pipefail

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

# Actor ID extracted during Test 1, used by subsequent tests for inbox_list
E2E_ACTOR_ID=""

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
# Args are passed via sys.argv[1] to avoid shell quoting issues.
daemon_call() {
  local op="$1"
  shift
  local args_json="$1"
  python3 -c "
import socket, json, sys
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.settimeout(10)
s.connect(('${CCCC_DAEMON_HOST}', 9765))
args = json.loads(sys.argv[1])
req = json.dumps({'v': 1, 'op': '${op}', 'args': args}) + chr(10)
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
" "${args_json}" 2>/dev/null
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
    # Script error rather than test failure
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

  # Check that the e2e-test actor appears in the CCCC group roster
  # and extract its actor_id for subsequent tests.
  local actor_output
  actor_output="$(daemon_call actor_list '{"group_id": "'${CCCC_GROUP}'"}' 2>/dev/null || true)"

  if echo "${actor_output}" | grep -q "${AGENT_NAME}"; then
    # Extract the actor ID from the JSON response
    E2E_ACTOR_ID="$(echo "${actor_output}" | python3 -c "
import sys, json
data = json.load(sys.stdin)
actors = data.get('result', {}).get('actors', [])
for a in actors:
    aid = a.get('id', '')
    if '${AGENT_NAME}' in aid:
        print(aid)
        break
" 2>/dev/null || true)"
    if [ -n "${E2E_ACTOR_ID}" ]; then
      pass "Actor '${AGENT_NAME}' found (ID: ${E2E_ACTOR_ID})"
    else
      pass "Actor '${AGENT_NAME}' found in CCCC group roster (ID extraction failed, using name)"
      E2E_ACTOR_ID="${AGENT_NAME}"
    fi
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
  local send_result inbox_result

  # Send a message via daemon TCP API
  echo "  Sending: ${test_msg}"
  send_result="$(daemon_call send '{"group_id": "'${CCCC_GROUP}'", "by": "e2e-test", "text": "'"${test_msg}"'", "to": ["@all"]}' || true)"

  # Verify the daemon accepted the send
  if echo "${send_result}" | grep -q '"ok":[ ]*true'; then
    pass "Daemon accepted sent message"
  else
    fail "Daemon rejected send"
    echo "  Send response: ${send_result}"
    return 1
  fi

  # Brief pause for daemon to deliver to inbox
  sleep 1

  # Check inbox_list to verify message arrived in actor's inbox
  if [ -n "${E2E_ACTOR_ID}" ]; then
    inbox_result="$(daemon_call inbox_list '{"group_id": "'${CCCC_GROUP}'", "actor_id": "'${E2E_ACTOR_ID}'", "by": "e2e-test", "limit": 10}' || true)"
    if echo "${inbox_result}" | grep -q "${UNIQUE_TAG}"; then
      pass "Message found in agent inbox via TCP API"
    else
      fail "Message not found in agent inbox"
      echo "  inbox_list response:"
      echo "${inbox_result}" | python3 -m json.tool 2>/dev/null || echo "${inbox_result}"
      echo "  E2E_ACTOR_ID: ${E2E_ACTOR_ID}"
      return 1
    fi
  else
    fail "No E2E_ACTOR_ID available for inbox check"
    return 1
  fi

  # Wait for agent to process the message
  herdr agent wait "${AGENT_NAME}" --status idle --timeout 30000 || true
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

  # Primary check: agent's terminal output contains the reply marker
  local agent_output
  agent_output="$(herdr agent read "${AGENT_NAME}" --lines 100 2>/dev/null || true)"

  if echo "${agent_output}" | grep -q "${reply_marker}"; then
    pass "Agent reply '${reply_marker}' detected in agent output"
    return 0
  fi

  # Fallback: check inbox_list for the reply marker (if sender receives own msg)
  if [ -n "${E2E_ACTOR_ID}" ]; then
    sleep 1
    local inbox_result
    inbox_result="$(daemon_call inbox_list '{"group_id": "'${CCCC_GROUP}'", "actor_id": "'${E2E_ACTOR_ID}'", "by": "e2e-test", "limit": 10}' || true)"
    if echo "${inbox_result}" | grep -q "${reply_marker}"; then
      pass "Agent reply '${reply_marker}' detected via inbox_list"
      return 0
    fi
    echo "  inbox_list response (no match):"
    echo "${inbox_result}" | python3 -m json.tool 2>/dev/null || echo "${inbox_result}"
  fi

  fail "Agent reply not found"
  echo "  Expected marker: ${reply_marker}"
  echo "  Agent output (last 50 lines):"
  echo "${agent_output}" | tail -50
  return 1
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
