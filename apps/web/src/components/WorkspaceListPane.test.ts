import { describe, expect, it } from "vite-plus/test";

import { getWorkspaceListPaneMaxWidth } from "./WorkspaceListPane";

describe("getWorkspaceListPaneMaxWidth", () => {
  it("uses the fixed cap before the row is measured and on wide rows", () => {
    expect(getWorkspaceListPaneMaxWidth()).toBe(512);
    expect(getWorkspaceListPaneMaxWidth(1_600)).toBe(512);
  });

  it("keeps the editor usable in a narrow window with the app sidebar open", () => {
    // 800px window minus a 208px app sidebar leaves a 592px row.
    expect(getWorkspaceListPaneMaxWidth(592)).toBe(232);
    expect(getWorkspaceListPaneMaxWidth(592.7)).toBe(232);
  });

  it("never drops below the pane's minimum width", () => {
    expect(getWorkspaceListPaneMaxWidth(400)).toBe(208);
  });
});
