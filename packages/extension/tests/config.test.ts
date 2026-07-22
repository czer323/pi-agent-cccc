// oxlint-disable typescript/no-unused-vars
import { expect, test, describe, beforeEach } from "vite-plus/test";
import { loadConfig } from "../src/config.ts";

const OLD_ENV = process.env;

beforeEach(() => {
  process.env = { ...OLD_ENV };
  // Clear CCCC group vars for clean slate
  delete process.env.CCCC_GROUP_ID;
  delete process.env.CCCC_GROUP_IDS;
  delete process.env.CCCC_AUTO_DISCOVER;
  delete process.env.CCCC_DEFAULT_GROUP_ID;
});

describe("loadConfig", () => {
  test("returns empty groups array when no CCCC_GROUP vars set", () => {
    const config = loadConfig();
    expect(config.groups).toEqual([]);
  });

  test("CCCC_GROUP_ID becomes single-element groups array", () => {
    process.env.CCCC_GROUP_ID = "my-group";
    const config = loadConfig();
    expect(config.groups).toEqual(["my-group"]);
  });

  test("CCCC_GROUP_IDS with single value returns single-element array", () => {
    process.env.CCCC_GROUP_IDS = "single-group";
    const config = loadConfig();
    expect(config.groups).toEqual(["single-group"]);
  });

  test("CCCC_GROUP_IDS with multiple values returns parsed array", () => {
    process.env.CCCC_GROUP_IDS = "group-a,group-b,group-c";
    const config = loadConfig();
    expect(config.groups).toEqual(["group-a", "group-b", "group-c"]);
  });

  test("CCCC_GROUP_IDS takes precedence over CCCC_GROUP_ID", () => {
    process.env.CCCC_GROUP_ID = "old-group";
    process.env.CCCC_GROUP_IDS = "new-group-a,new-group-b";
    const config = loadConfig();
    expect(config.groups).toEqual(["new-group-a", "new-group-b"]);
  });

  test("trims whitespace from group IDs", () => {
    process.env.CCCC_GROUP_IDS = "  g1 , g2 , g3  ";
    const config = loadConfig();
    expect(config.groups).toEqual(["g1", "g2", "g3"]);
  });

  test("CCCC_GROUP_IDS with empty string returns empty array", () => {
    process.env.CCCC_GROUP_IDS = "";
    const config = loadConfig();
    expect(config.groups).toEqual([]);
  });

  test("autoDiscover defaults to true when CCCC_AUTO_DISCOVER not set", () => {
    const config = loadConfig();
    expect(config.autoDiscover).toBe(true);
  });

  test("autoDiscover is true when CCCC_AUTO_DISCOVER is true", () => {
    process.env.CCCC_AUTO_DISCOVER = "true";
    const config = loadConfig();
    expect(config.autoDiscover).toBe(true);
  });

  test("autoDiscover is false when CCCC_AUTO_DISCOVER is false", () => {
    process.env.CCCC_AUTO_DISCOVER = "false";
    const config = loadConfig();
    expect(config.autoDiscover).toBe(false);
  });

  test("defaultGroupId parses from CCCC_DEFAULT_GROUP_ID", () => {
    process.env.CCCC_DEFAULT_GROUP_ID = "lobby";
    const config = loadConfig();
    expect(config.defaultGroupId).toBe("lobby");
  });

  test("defaultGroupId is null when CCCC_DEFAULT_GROUP_ID not set", () => {
    const config = loadConfig();
    expect(config.defaultGroupId).toBeNull();
  });
});

describe("agentTitle", () => {
  test('defaults to "Pi Agent" when CCCC_AGENT_TITLE not set', () => {
    delete process.env.CCCC_AGENT_TITLE;
    const config = loadConfig();
    expect(config.agentTitle).toBe("Pi Agent");
  });

  test("reads from CCCC_AGENT_TITLE env var", () => {
    process.env.CCCC_AGENT_TITLE = "My Custom Agent";
    const config = loadConfig();
    expect(config.agentTitle).toBe("My Custom Agent");
  });
});

describe("subAgentTitle", () => {
  test('defaults to "Pi Sub-Agent" when CCCC_SUB_AGENT_TITLE not set', () => {
    delete process.env.CCCC_SUB_AGENT_TITLE;
    const config = loadConfig();
    expect(config.subAgentTitle).toBe("Pi Sub-Agent");
  });

  test("reads from CCCC_SUB_AGENT_TITLE env var", () => {
    process.env.CCCC_SUB_AGENT_TITLE = "My Sub-Agent";
    const config = loadConfig();
    expect(config.subAgentTitle).toBe("My Sub-Agent");
  });
});
