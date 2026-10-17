import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SidebarContentSlot } from "./SidebarContentSlot";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("SidebarContentSlot", () => {
  it("keeps the expanded sidebar's shortcuts registered across collapse and expand", async () => {
    const onShortcut = vi.fn();
    const lifecycle: string[] = [];
    const shortcutHandlers = new Set<() => void>();
    // Stands in for the expanded sidebar: registers a shortcut handler for as long as it is mounted.
    function ExpandedSidebar() {
      useEffect(() => {
        lifecycle.push("mount");
        shortcutHandlers.add(onShortcut);
        return () => {
          lifecycle.push("unmount");
          shortcutHandlers.delete(onShortcut);
        };
      }, []);
      return createElement("nav", null, "threads");
    }
    const render = (showRail: boolean) =>
      createElement(
        SidebarContentSlot,
        { showRail, rail: createElement("aside", null, "rail") },
        createElement(ExpandedSidebar),
      );
    const pressShortcut = () => {
      for (const handler of shortcutHandlers) handler();
    };

    await act(() => {
      root.render(render(false));
    });
    await act(() => root.render(render(true)));
    pressShortcut();
    await act(() => root.render(render(false)));
    pressShortcut();

    expect(lifecycle).toEqual(["mount"]);
    expect(onShortcut).toHaveBeenCalledTimes(2);
    expect(container.querySelectorAll("aside")).toHaveLength(0);
    await act(() => root.render(render(true)));
    expect(container.querySelectorAll("aside")).toHaveLength(1);
  });
});
