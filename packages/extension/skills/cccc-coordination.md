---
name: cccc-coordination
description: Guidance for coordinating work through the CCCC daemon bridge extension. Use when sending/receiving CCCC messages, delegating sub-agents, or discovering group actors.
---

# CCCC Coordination

How to coordinate with other agents through the CCCC bridge extension (`cccc_send`, `cccc_reply`, `cccc_whoami`, `cccc_list_actors`).

Each agent in a CCCC group is independent — messages are the only shared state between them.

---

## 1. Tool Selection: `cccc_send` vs `cccc_reply`

- **Start a new topic / notify** → `cccc_send` with `to: "@all"` or a specific actor ID.
- **Respond to an incoming event** → `cccc_reply(eventId: ...)` — threads the reply to the original message, so recipients see the conversation tree.
- **Blocking request** → set `reply_required: true` (see Best Practices below).

---

## 2. Addressing Messages

- `to: "@all"` — every actor in the group (default).
- `to: "@foreman"` — only the foreman/lead actor.
- `to: "<actor-id>"` — a specific actor by their CCCC ID (see `cccc_list_actors`).
- `to: ["actor-1", "actor-2"]` — multiple specific recipients (pass as array).

---

## 3. Discovering Your Identity: `cccc_whoami`

Call `cccc_whoami` at session start to learn your:

- **Actor ID** — how others address you.
- **Connected group IDs** — which groups you can send to.

Use this to announce your presence or to verify which actor the runtime assigned.

---

## 4. Checking the Roster: `cccc_list_actors`

Before delegating work, call `cccc_list_actors` to see:

- Who is available (running vs idle).
- Each actor's title, runtime, and runner.
- Their exact actor ID for addressing messages.

Re-query when expectations don't match — the roster can change as agents come and go.

---

## 5. Interpreting Incoming Messages

Each delivered message carries:

- **Provenance** — sender ID, group ID, event ID (`eventId`).
- **`reply_required` flag** — if true, a response is expected.
- **Content** — the message text.

When `reply_required` is set: respond with `cccc_reply(eventId: ..., text: ...)`. Acknowledge receipt via `cccc_reply` when appropriate.

---

## 6. Best Practices

- **Keep messages concise.** CCCC messages are visible to all group members.
- **Use `reply_required` for blocking requests.** Recipients know to prioritize responding.
- **Acknowledge important messages.** A brief `cccc_reply` confirms you received and understand the task.
- **Check group roster before delegating.** Avoid sending work to absent or busy actors.
- **Include context in every send.** The recipient has no shared conversation history — state the task, file paths, and expected output explicitly.

---

## 7. Sub-Agent Pattern

Sub-agents are independent sessions registered with a child actor ID derived from the parent.

**Parent side:**

1. Spawn a sub-agent (via `task` tool or session launch).
2. Send work via `cccc_send(to: "<sub-agent-id>", text: "...")` or let the sub-agent self-register via env vars.
3. Wait for the sub-agent's result report over CCCC.

**Sub-agent side:**

1. On startup, call `cccc_whoami` to learn your actor ID.
2. Perform assigned work.
3. Report results back via `cccc_send(to: "<parent-actor-id>", text: "<summary>")`.
4. If blocked, send a `cccc_send` with the blocker details so the parent can assist.

**Key constraints:**

- Always include the parent actor ID in your task assignment so the sub-agent knows where to report.
- Sub-agents are ephemeral — their actor is removed when they shut down.
