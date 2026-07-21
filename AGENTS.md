# Agent Instructions

## AGENTS.md — 12 Rules for Codex / OpenCode / Cursor

### Rules

1. **Think before coding.** State assumptions out loud. Surface tradeoffs. Push back when a simpler approach exists. No silent guesses.
2. **Simplicity first.** Minimum code that solves the stated problem. No speculative features. No abstractions for single-use code.
3. **Surgical changes.** Touch only what the task requires. Don't "improve" adjacent code, comments, or formatting. Match existing style.
4. **Goal-driven execution.** Define success criteria up front, then loop until verified.
5. **Don't make the model do non-language work.** Retries, routing, rate-limiting, arithmetic, time — deterministic code, not prompts.
6. **Hard token budget.** Every loop gets a ceiling. If the same input has been re-chewed for 90 minutes, stop.
7. **Surface conflicts, don't average them.** Two codebase patterns disagreeing → pick one visibly and say why.
8. **Read before you write.** Understand adjacent code before adding new code.
9. **Tests are gated by correctness, not "pass."** Assertions must be tied to behavior, not shape.
10. **Long-running operations need checkpoints.** Commit between steps.
11. **Convention beats novelty.** Use the codebase's established pattern.
12. **Fail visibly, not silently.** Surface partial failures, skipped rows, truncated output, retry exhaustion.
13. **Use Test Driven Development.** Write a failing test before writing code that makes it pass. This MUST be done prior to implementing code.

## Project Structure

Extension source lives in `packages/extension/` under the repo root:

```
.                              # repo root
  packages/extension/          # extension source
    package.json               # deps + "pi.extensions" manifest
    vite.config.ts             # Vite Plus (vp) configuration
    tsconfig.json              # strict TypeScript config
    oxlintrc.json              # oxlint rules
    src/
      index.ts                 # entry point (default export factory)
      client.ts                # CCCC daemon client wrapper
      actor.ts                 # actor registration / identity
      inbox.ts                 # inbox polling and delivery
      config.ts                # env/config reading
      types.ts                 # shared types
  .github/
    PULL_REQUEST_TEMPLATE.md   # PR template
  .beads/                      # br issue tracking
  AGENTS.md                    # this file
```

**First-time setup:**

```bash
# Install Vite Plus globally via mise
mise use -g npm:vite-plus

# Install extension dependencies
cd packages/extension && pnpm install

# Symlink for pi-agent runtime discovery
ln -s "$PWD/packages/extension" ~/.pi/agent/extensions/cccc-bridge
```

## Workflow

All changes live in branches. `main` is always deployable.

Three roles handle the work cycle. An agent may fill any role — read the REQUIRED documents before starting. All roles MUST read the required documentation for their role.

## Subagent Dispatch Preamble

Every subagent task assignment (Planner → Implementer, Implementer → Reviewer,
or any other agent-to-agent spawn) MUST open with this block:

```md Preamble
## READ THIS FIRST
Read AGENTS.md for the [Role] workflow before doing anything else.
Run `br capabilities --json` to see the available br commands if context is needed (if `.beads/` is missing, run `br init` first).
The assignment below is your task. The docs above are how to execute it.
Do not skip this step.
```

### Role: Planner

Planner MUST read: `planning-and-task-breakdown`, `incremental-implementation`. Run `br robot-docs guide` for br command reference (fallback: `br --help`).

Note: Do not respond with a full report of the environment on start.  You will however be asked, so do the research and be prepared.

1. **Collaborate** work with user to determine goals and ask questions to help determine scope.
2. **Research** the topic by checking existing code or documentation.  Web search and Context7 tools for building confidence in idea.
3. **Agree** Both user and planner must agree to the goal.
4. **Skim** the codebase for relevant existing patterns (config, models, CLI).
5. **Map** — Run `bv --robot-triage --format toon` for the current graph state. Map dependencies — what needs to exist before what.
6. **Slice** into ordered, vertical, testable increments. Each slice should leave the system working.
7. **Output** — cards created in br tracking the goal and tasks necessary to accomplish.  `br lint --json` must pass.
8. **Review** — Re-run `bv --robot-triage --format toon` to verify all dependencies are wired. Run `bv --robot-suggest --format toon` to catch missing edges `bv` might have spotted.
9. **Delegation** If asked to spawn an implementer, provide only the following information:
   - Role: Implementer
   - br card ID
   - Branch name
   - Specific concerns to flag (if any, otherwise omit)

Planner writes no production code. Output is a plan with tasks.

### Role: Implementer

Implementer MUST read: `test-driven-development`, `incremental-implementation`, `conventional-branch`, `conventional-commit`

```md Escape Hatches
## BLOCKER: Stop. IRC the planner with:
- What you're blocked on
- What you tried (2-3 things max)
- What you need
Do NOT attempt workaround. This IS task completion for this slice.  Planner will assist with unblocking or providing guidance.

## OUT-OF-SCOPE DISCOVERY: Create a br issue.
br create --title="Brief discovery" \
   --description="What I found, where, and why it's out of scope" \
   --type=task --priority=3
```

1. **Claim** — `bv --robot-next --format toon` returns an issue ID. Claim it with `br update <id> --claim` where `<id>` is the ID from bv's output.
2. **Branch** — `git checkout -b <type>/<short-name>` from `main`.
3. **Plan** - Generate a todo list using tools to track progress.
4. **Implement slice by slice** — For each slice:
   - RED: write a failing test
   - GREEN: implement minimal code to pass
   - REFACTOR: clean up, keep tests green
   - COMMIT: conventional commit message
5. **Prepare** — `vp check --fix` to auto-format and auto-fix lint errors.
6. **Gate** — `vp check`. Red → fix, green → proceed.
7. **Review** — Gate green? Spawn a `reviewer` subagent on the diff.
   - Open with the Subagent Dispatch Preamble before the review request and provide ONLY the following:
      - Role: Reviewer
      - br card ID
      - Branch name
      - Specific concerns to flag (if any, otherwise omit)
8. **Ship** — Push branch. Create PR against `main` using `.github/PULL_REQUEST_TEMPLATE.md`.  Link the br card in the PR body.
9. **Merge** — Once reviewer approves, merge via `gh pr merge <number>`.
10. **Close** — `br close <id>` with implementation notes. Delete the branch.
11. **Sync** — `br sync --flush-only && git add .beads/ && git commit -m "chore(beads): sync issue state" && git push`.
`vp check` before every commit. Red → fix, green → commit.

#### Commands

Run `vp <task>` for common development tasks.

| Task | What it does |
|---|---|
| `vp check` | **Tollgate.** Runs oxfmt (format) + oxlint + tsc type check. |
| `vp check --fix` | Auto-format and auto-fix lint, then type check. |
| `vp test` | Run tests with vitest. |
| `vp lint` | Lint with oxlint. |
| `vp format` | Auto-format code with oxfmt. |

### Role: Reviewer

Reviewer MUST Read: `code-review-and-quality`, `test-driven-development/testing-anti-patterns.md`. Run `br robot-docs guide` for br command reference (fallback: `br --help`).

1. **Understand** — read the Subagent Dispatch Preamble.  `br show <id>` for the card's ACs and scope.  Fetch the diff: `git diff main...<branch>`.  Does the diff satisfy the card's acceptance criteria?
2. **Review tests first** — do they exist? Do they test behavior, not implementation? Would they catch a regression?  Cross-check against the br card's acceptance criteria — does the implementation cover all of them?
3. **Review code** — walk the diff through the five axes:
   - Correctness — edge cases, error paths, race conditions
   - Readability — naming, complexity, unnecessary cleverness
   - Architecture — does it fit? Duplication? Correct module boundaries?
   - Security — untrusted input, path traversal, secrets
   - Performance — N+1, unbounded loops, hot paths
4. **Categorize findings** — Critical, Required, Optional/Nit, FYI.
5. **Post verdict** — Approve or Request Changes (list what's required).
6. **Done** — Yield on completion with summary to Implementer.

## Issue Tracking

This project uses `br` (beads_rust). Run `br robot-docs guide` for the full command reference (fallback: `br --help`).

**Acceptance criteria:** every issue needs them. Set via:

```
br update <id> --acceptance "<text>"
```

**Audit trail:** br supports `--actor "$ACTOR"` on all mutating commands. Optional for single-agent — omit it and `created_by` defaults to `"unknown"`.

**bv dependency:** `bv --robot-triage` / `--robot-next` / `--robot-suggest` provide graph-aware task selection. If `bv` is unavailable, use `br list` and `br show` manually.

### Branch Naming & Commits

Format: `<type>/<description>`. Types: `feature/`, `bugfix/`, `hotfix/`, `release/`, `chore/`.
Commit prefix aligns with branch type (`feature/` → `feat:`, `bugfix/` → `fix:`, `chore/` → `chore:`).
Examples: `feature/add-oauth`, `fix/header-overflow`, `chore/update-deps`.

### GitHub CLI (gh)

Create and manage PRs via `gh`:

```bash
# Create a PR
gh pr create \
  --title "type(scope): summary" \
  --head <branch> --base main \
  --repo czer323/pi-agent-cccc \
  --body @/tmp/pr_body.txt

# Merge (strategy is situational — squash or rebase per PR context)
gh pr merge <number>
```

PR body template (see `.github/PULL_REQUEST_TEMPLATE.md`):

```
## Type

<!-- feat / fix / chore / refactor / docs / test -->

## Description

<!-- what changed and why -->

## Related Issues

Closes <issue-id>

## Checklist

- [ ] `vp check` passes
- [ ] Related test(s) added or updated
- [ ] Acceptance criteria met (br issue)
```

