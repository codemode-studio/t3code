import { profileScopeForId } from "@t3tools/client-runtime/state/profile-scope";
import { ProviderProfileId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildHomeListFilterMenu,
  buildHomeProfileMenuAction,
  resolveHomeProfileMenuEvent,
  type HomeListFilterMenuProfile,
} from "./home-list-filter-menu";

const acme = ProviderProfileId.make("acme");
const profiles: ReadonlyArray<HomeListFilterMenuProfile> = [
  { scope: profileScopeForId(acme), label: "Acme", color: "#ea580c" },
  { scope: "unassigned", label: "Unassigned", color: null },
];

describe("buildHomeListFilterMenu", () => {
  it("adds a project scope submenu that selects and clears the same scope as the chips", () => {
    const onProjectChange = vi.fn();
    const menu = buildHomeListFilterMenu({
      environments: [],
      projects: [
        { key: "environment-1:project-1", label: "Codething" },
        { key: "environment-1:project-2", label: "Website" },
      ],
      profiles: [],
      selectedEnvironmentId: null,
      selectedProjectKey: "environment-1:project-1",
      selectedProfileScope: "all",
      onEnvironmentChange: vi.fn(),
      onProjectChange,
      onProfileScopeChange: vi.fn(),
    });

    const projectMenu = menu.items.find(
      (item) => item.type === "submenu" && item.title === "Project",
    );
    expect(menu.items.some((item) => item.title === "Settings")).toBe(false);
    expect(projectMenu).toMatchObject({
      type: "submenu",
      items: [
        { title: "All projects", state: "off" },
        { title: "Codething", state: "on" },
        { title: "Website", state: "off" },
      ],
    });
    if (projectMenu?.type !== "submenu") throw new Error("Expected project submenu");

    projectMenu.items[0]?.onPress();
    projectMenu.items[2]?.onPress();
    expect(onProjectChange).toHaveBeenNthCalledWith(1, null);
    expect(onProjectChange).toHaveBeenNthCalledWith(2, "environment-1:project-2");
  });

  it("shows a profile submenu only when profiles exist, and selects scopes from it", () => {
    const onProfileScopeChange = vi.fn();
    const baseProps = {
      environments: [],
      projects: [],
      selectedEnvironmentId: null,
      selectedProjectKey: null,
      selectedProfileScope: profileScopeForId(acme),
      onEnvironmentChange: vi.fn(),
      onProjectChange: vi.fn(),
      onProfileScopeChange,
    };
    expect(
      buildHomeListFilterMenu({ ...baseProps, profiles: [] }).items.map((item) => item.title),
    ).toEqual(["Environment"]);

    const menu = buildHomeListFilterMenu({ ...baseProps, profiles });
    const profileMenu = menu.items[0];
    expect(profileMenu).toMatchObject({
      type: "submenu",
      title: "Profile",
      items: [
        { title: "All profiles", state: "off" },
        { title: "Acme", state: "on" },
        { title: "Unassigned", state: "off" },
      ],
    });
    if (profileMenu?.type !== "submenu") throw new Error("Expected profile submenu");
    profileMenu.items[0]?.onPress();
    profileMenu.items[2]?.onPress();
    expect(onProfileScopeChange).toHaveBeenNthCalledWith(1, "all");
    expect(onProfileScopeChange).toHaveBeenNthCalledWith(2, "unassigned");
  });

  it("builds a MenuView profile submenu with color dots whose events round-trip", () => {
    expect(buildHomeProfileMenuAction([], "all")).toBeNull();
    const action = buildHomeProfileMenuAction(profiles, "unassigned");
    expect(action?.subactions).toEqual([
      expect.objectContaining({ id: "profile-scope:all", state: "off" }),
      {
        id: "profile-scope:profile:acme",
        title: "Acme",
        state: "off",
        image: "circle.fill",
        imageColor: "#ea580c",
      },
      { id: "profile-scope:unassigned", title: "Unassigned", state: "on" },
    ]);

    expect(resolveHomeProfileMenuEvent("profile-scope:all", profiles)).toBe("all");
    expect(resolveHomeProfileMenuEvent("profile-scope:profile:acme", profiles)).toBe(
      "profile:acme",
    );
    expect(resolveHomeProfileMenuEvent("profile-scope:unassigned", profiles)).toBe("unassigned");
    expect(resolveHomeProfileMenuEvent("profile-scope:profile:deleted", profiles)).toBeNull();
    expect(resolveHomeProfileMenuEvent("project:environment-1:project-1", profiles)).toBeNull();
  });

  it("keeps a profile named All apart from the all-profiles choice", () => {
    const named = [
      { scope: profileScopeForId(ProviderProfileId.make("all")), label: "All", color: null },
    ] as const;
    expect(resolveHomeProfileMenuEvent("profile-scope:all", named)).toBe("all");
    expect(resolveHomeProfileMenuEvent("profile-scope:profile:all", named)).toBe("profile:all");
  });
});
