import { expect, test } from "vite-plus/test";
import mod from "../src/index.ts";

test("default export is a function", () => {
  expect(typeof mod).toBe("function");
});
