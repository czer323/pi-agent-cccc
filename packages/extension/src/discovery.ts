import { execSync } from "node:child_process";
import type { CCCCBridgeClient, GroupsResult, GroupShowResult } from "./client.ts";

/**
 * Scope descriptor attached to a CCCC group.
 * Represents a path (filesystem or URL) that the group is "scoped" to,
 * typically a git repo root or project directory.
 */
export interface ScopeInfo {
  scope_key: string;
  url: string;
  label?: string;
  git_remote?: string;
}

/**
 * Group descriptor from the daemon's groups() listing.
 * The full {@link scopes} array may only be available via groupShow().
 */
export interface GroupInfo {
  group_id: string;
  title?: string;
  scopes?: ScopeInfo[];
}

function pathMatchesScope(path: string, scopeKey: string): boolean {
  // Exact match
  if (path === scopeKey) return true;
  // Prefix match: scopeKey is a parent directory of path
  const prefix = scopeKey.endsWith("/") ? scopeKey : scopeKey + "/";
  return path.startsWith(prefix);
}

/**
 * Attempt to resolve the git repository root for a given working directory.
 * Returns `null` if the directory is not inside a git repository.
 */
function resolveGitRoot(cwd: string): string | null {
  try {
    return execSync("git rev-parse --show-toplevel 2>/dev/null", {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Discover CCCC groups whose scope matches the current working directory
 * or its git repository root.
 *
 * Flow:
 * 1. Resolve git repo root from cwd (if inside a repo).
 * 2. Call `client.groups()` to list all groups.
 * 3. If a group's scopes are absent from the listing, fetch full details
 *    via `client.groupShow()`.
 * 4. Match each group's scope keys against cwd and git root.
 *
 * @returns Array of matching group IDs (may be empty).
 */
export async function discoverGroups(client: CCCCBridgeClient, cwd: string): Promise<string[]> {
  const gitRoot = resolveGitRoot(cwd);

  const result: GroupsResult = (await client.groups()) as GroupsResult;
  const groups: GroupInfo[] = result.groups ?? [];
  const matches: string[] = [];

  for (const group of groups) {
    let scopes = group.scopes ?? [];

    if (scopes.length === 0) {
      try {
        const detail: GroupShowResult = (await client.groupShow(group.group_id)) as GroupShowResult;
        const detailedGroup = detail.group as GroupInfo | undefined;
        scopes = detailedGroup?.scopes ?? [];
      } catch {
        continue;
      }
    }

    for (const scope of scopes) {
      if (scope.scope_key) {
        if (
          pathMatchesScope(cwd, scope.scope_key) ||
          (gitRoot &&
            (pathMatchesScope(gitRoot, scope.scope_key) ||
              pathMatchesScope(scope.scope_key, gitRoot)))
        ) {
          matches.push(group.group_id);
          break;
        }
      }
    }
  }

  return matches;
}
