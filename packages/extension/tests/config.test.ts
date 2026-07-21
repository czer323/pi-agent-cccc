// oxlint-disable typescript/no-unused-vars
import { expect, test, describe, beforeEach } from "vite-plus/test";
import { loadConfig } from "../src/config.ts";

const OLD_ENV = process.env;

beforeEach(() => {
  process.env = { ...OLD_ENV };
  // Clear CCCC group vars for clean slate
  delete process.env.CCCC_GROUP_ID;
  delete process.env.CCCC_GROUP_IDS;
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
});
