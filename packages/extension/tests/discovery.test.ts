// oxlint-disable typescript/no-unused-vars
import { expect, test, describe, vi, beforeEach } from "vite-plus/test";
import type { CCCCClientLike } from "../src/types.ts";

// Mock child_process.execSync before importing discovery
const { mockExecSync } = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execSync: mockExecSync,
}));

import { discoverGroups } from "../src/discovery.ts";
import { CCCCBridgeClient } from "../src/client.ts";

function createMockClient(): CCCCClientLike {
  return {
    actorAdd: vi.fn(),
    inboxList: vi.fn(),
    inboxMarkRead: vi.fn(),
    eventsStream: vi.fn() as any,
    sendCrossGroup: vi.fn(),
    groups: vi.fn(),
    groupShow: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("discoverGroups", () => {
  test("returns empty array when daemon returns no groups", async () => {
    const mockClient = createMockClient();
    (mockClient.groups as any).mockResolvedValue({ groups: [] });
    const bridge = new CCCCBridgeClient(mockClient);

    const result = await discoverGroups(bridge, "/home/user/project");

    expect(result).toEqual([]);
    expect(mockClient.groups).toHaveBeenCalledOnce();
  });

  test("matches group scope against cwd exactly", async () => {
    const mockClient = createMockClient();
    (mockClient.groups as any).mockResolvedValue({
      groups: [
        {
          group_id: "my-group",
          title: "My Group",
          scopes: [{ scope_key: "/home/user/project", url: "file:///home/user/project" }],
        },
      ],
    });

    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const bridge = new CCCCBridgeClient(mockClient);
    const result = await discoverGroups(bridge, "/home/user/project");

    expect(result).toEqual(["my-group"]);
  });

  test("matches group scope when cwd is a subdirectory of scope", async () => {
    const mockClient = createMockClient();
    (mockClient.groups as any).mockResolvedValue({
      groups: [
        {
          group_id: "repo-group",
          scopes: [{ scope_key: "/repos/my-project", url: "file:///repos/my-project" }],
        },
      ],
    });

    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const bridge = new CCCCBridgeClient(mockClient);
    const result = await discoverGroups(bridge, "/repos/my-project/src/lib");

    expect(result).toEqual(["repo-group"]);
  });

  test("matches group scope against git root when available", async () => {
    const mockClient = createMockClient();
    (mockClient.groups as any).mockResolvedValue({
      groups: [
        {
          group_id: "git-group",
          scopes: [{ scope_key: "/repos/my-project", url: "file:///repos/my-project" }],
        },
      ],
    });

    // cwd is deeper but git root matches
    mockExecSync.mockReturnValue("/repos/my-project\n");

    const bridge = new CCCCBridgeClient(mockClient);
    // cwd is unrelated but git root matches
    const result = await discoverGroups(bridge, "/home/user");

    expect(result).toEqual(["git-group"]);
  });

  test("returns multiple matching groups", async () => {
    const mockClient = createMockClient();
    (mockClient.groups as any).mockResolvedValue({
      groups: [
        {
          group_id: "group-a",
          scopes: [{ scope_key: "/projects/a", url: "file:///projects/a" }],
        },
        {
          group_id: "group-b",
          scopes: [{ scope_key: "/projects/b", url: "file:///projects/b" }],
        },
        {
          group_id: "group-c",
          scopes: [{ scope_key: "/other/place", url: "file:///other/place" }],
        },
      ],
    });

    mockExecSync.mockReturnValue("/projects\n");

    const bridge = new CCCCBridgeClient(mockClient);
    const result = await discoverGroups(bridge, "/projects/a/src");

    expect(result).toEqual(["group-a", "group-b"]);
  });

  test("fetches group details via groupShow when scopes are missing from listing", async () => {
    const mockClient = createMockClient();
    (mockClient.groups as any).mockResolvedValue({
      groups: [
        { group_id: "detailed-group" }, // No scopes in listing
      ],
    });
    (mockClient.groupShow as any).mockResolvedValue({
      group: {
        group_id: "detailed-group",
        scopes: [{ scope_key: "/deep/path", url: "file:///deep/path" }],
      },
    });

    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const bridge = new CCCCBridgeClient(mockClient);
    const result = await discoverGroups(bridge, "/deep/path/subdir");

    expect(result).toEqual(["detailed-group"]);
    expect(mockClient.groupShow).toHaveBeenCalledWith("detailed-group");
  });

  test("skips group when groupShow fails", async () => {
    const mockClient = createMockClient();
    (mockClient.groups as any).mockResolvedValue({
      groups: [
        { group_id: "fails-to-show" }, // No scopes, groupShow will fail
        {
          group_id: "works-fine",
          scopes: [{ scope_key: "/good/path", url: "file:///good/path" }],
        },
      ],
    });
    (mockClient.groupShow as any).mockRejectedValue(new Error("daemon error"));

    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const bridge = new CCCCBridgeClient(mockClient);
    const result = await discoverGroups(bridge, "/good/path");

    expect(result).toEqual(["works-fine"]);
  });

  test("matches group when scope uses trailing slash", async () => {
    const mockClient = createMockClient();
    (mockClient.groups as any).mockResolvedValue({
      groups: [
        {
          group_id: "trailing-group",
          scopes: [{ scope_key: "/path/with/slash/", url: "file:///path/with/slash/" }],
        },
      ],
    });

    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const bridge = new CCCCBridgeClient(mockClient);
    const result = await discoverGroups(bridge, "/path/with/slash/sub");

    expect(result).toEqual(["trailing-group"]);
  });

  test("does not match groups with unrelated scopes", async () => {
    const mockClient = createMockClient();
    (mockClient.groups as any).mockResolvedValue({
      groups: [
        {
          group_id: "unrelated",
          scopes: [{ scope_key: "/somewhere/else", url: "file:///somewhere/else" }],
        },
      ],
    });

    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const bridge = new CCCCBridgeClient(mockClient);
    const result = await discoverGroups(bridge, "/my/own/path");

    expect(result).toEqual([]);
  });
});
