import { describe, expect, it } from "vite-plus/test";

import { parseMacWindowNumber } from "./MacWindowBlur.ts";

describe("parseMacWindowNumber", () => {
  it("reads the CGWindowID from a window media source id", () => {
    expect(parseMacWindowNumber("window:4821:0")).toBe(4821);
  });

  it.each(["window:0:0", "screen:1:0", ""])("rejects a source without a window: %s", (id) => {
    expect(parseMacWindowNumber(id)).toBeNull();
  });
});
