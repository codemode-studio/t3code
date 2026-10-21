import { createElement, useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";

import { SidebarContentSlot } from "./SidebarContentSlot";

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
    const content = (showRail: boolean) =>
      createElement(
        SidebarContentSlot,
        { showRail, rail: createElement("aside", null, "rail") },
        createElement(ExpandedSidebar),
      );
    const pressShortcut = () => {
      for (const handler of shortcutHandlers) handler();
    };

    await using screen = await render(content(false), { router: false });
    await screen.rerender(content(true));
    pressShortcut();
    await screen.rerender(content(false));
    pressShortcut();

    expect(lifecycle).toEqual(["mount"]);
    expect(onShortcut).toHaveBeenCalledTimes(2);
    expect(screen.container.querySelectorAll("aside")).toHaveLength(0);
    await screen.rerender(content(true));
    expect(screen.container.querySelectorAll("aside")).toHaveLength(1);
  });
});
