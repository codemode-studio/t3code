import { act, createElement, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import { SidebarContentSlot } from "./SidebarContentSlot";

describe("SidebarContentSlot", () => {
  it("keeps the expanded sidebar's shortcuts registered across collapse and expand", () => {
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

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(render(false));
    });
    act(() => renderer.update(render(true)));
    pressShortcut();
    act(() => renderer.update(render(false)));
    pressShortcut();

    expect(lifecycle).toEqual(["mount"]);
    expect(onShortcut).toHaveBeenCalledTimes(2);
    expect(renderer.root.findAllByType("aside")).toHaveLength(0);
    act(() => renderer.update(render(true)));
    expect(renderer.root.findAllByType("aside")).toHaveLength(1);
    act(() => renderer.unmount());
  });
});
