import type { ProfileScope } from "@t3tools/client-runtime/state/profile-scope";
import type { EnvironmentId } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";

export interface HomeListFilterMenuEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export interface HomeListFilterMenuProject {
  readonly key: string;
  readonly label: string;
}

/** One non-"All profiles" choice in the profile filter: a profile, or "Unassigned". */
export interface HomeListFilterMenuProfile {
  readonly scope: Exclude<ProfileScope, "all">;
  readonly label: string;
  readonly color: string | null;
}

type HomeListFilterMenuAction = {
  readonly type: "action";
  readonly title: string;
  readonly subtitle?: string;
  readonly state?: "on" | "off";
  readonly onPress: () => void;
};

type HomeListFilterMenuSubmenu = {
  readonly type: "submenu";
  readonly title: string;
  readonly items: HomeListFilterMenuAction[];
};

export interface HomeListFilterMenu {
  readonly title: string;
  readonly items: Array<HomeListFilterMenuAction | HomeListFilterMenuSubmenu>;
}

export function buildHomeListFilterMenu(props: {
  readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  /** Empty hides the profile filter. */
  readonly profiles: ReadonlyArray<HomeListFilterMenuProfile>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly selectedProfileScope: ProfileScope;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly onProfileScopeChange: (scope: ProfileScope) => void;
}): HomeListFilterMenu {
  const items: Array<HomeListFilterMenuAction | HomeListFilterMenuSubmenu> = [];

  // Native UIMenus tint every icon, so profile colors only show in the MenuView menus.
  if (props.profiles.length > 0) {
    items.push({
      type: "submenu",
      title: "Profile",
      items: [
        {
          type: "action",
          title: "All profiles",
          subtitle: "Show threads from every profile",
          state: props.selectedProfileScope === "all" ? "on" : "off",
          onPress: () => props.onProfileScopeChange("all"),
        },
        ...props.profiles.map((profile) => ({
          type: "action" as const,
          title: profile.label,
          state: props.selectedProfileScope === profile.scope ? ("on" as const) : ("off" as const),
          onPress: () => props.onProfileScopeChange(profile.scope),
        })),
      ],
    });
  }

  items.push({
    type: "submenu",
    title: "Environment",
    items: [
      {
        type: "action",
        title: "All environments",
        subtitle: "Show threads from every environment",
        state: props.selectedEnvironmentId === null ? "on" : "off",
        onPress: () => props.onEnvironmentChange(null),
      },
      ...props.environments.map((environment) => ({
        type: "action" as const,
        title: environment.label,
        state:
          props.selectedEnvironmentId === environment.environmentId
            ? ("on" as const)
            : ("off" as const),
        onPress: () => props.onEnvironmentChange(environment.environmentId),
      })),
    ],
  });

  if (props.projects.length > 0) {
    items.push({
      type: "submenu",
      title: "Project",
      items: [
        {
          type: "action",
          title: "All projects",
          subtitle: "Show threads from every project",
          state: props.selectedProjectKey === null ? "on" : "off",
          onPress: () => props.onProjectChange(null),
        },
        ...props.projects.map((project) => ({
          type: "action" as const,
          title: project.label,
          state: props.selectedProjectKey === project.key ? ("on" as const) : ("off" as const),
          onPress: () => props.onProjectChange(project.key),
        })),
      ],
    });
  }

  return {
    title: "Thread list options",
    items,
  };
}

// Distinct from the `profile:<id>` scope values the ids carry after it.
const PROFILE_MENU_ACTION_PREFIX = "profile-scope:";

/**
 * The profile submenu for MenuView-based filter menus (Android, and the iPad sidebar's
 * non-native header), with each profile's color as a dot. Null when there are no profiles.
 */
export function buildHomeProfileMenuAction(
  profiles: ReadonlyArray<HomeListFilterMenuProfile>,
  selectedScope: ProfileScope,
): MenuAction | null {
  if (profiles.length === 0) return null;
  return {
    id: "profile",
    title: "Profile",
    subactions: [
      {
        id: `${PROFILE_MENU_ACTION_PREFIX}all`,
        title: "All profiles",
        subtitle: "Show threads from every profile",
        state: selectedScope === "all" ? "on" : "off",
      },
      ...profiles.map((profile): MenuAction => ({
        id: `${PROFILE_MENU_ACTION_PREFIX}${profile.scope}`,
        title: profile.label,
        state: selectedScope === profile.scope ? "on" : "off",
        ...(profile.color === null ? {} : { image: "circle.fill", imageColor: profile.color }),
      })),
    ],
  };
}

/** The scope a `buildHomeProfileMenuAction` event picks, or null for other menu events. */
export function resolveHomeProfileMenuEvent(
  event: string,
  profiles: ReadonlyArray<HomeListFilterMenuProfile>,
): ProfileScope | null {
  if (!event.startsWith(PROFILE_MENU_ACTION_PREFIX)) return null;
  const scope = event.slice(PROFILE_MENU_ACTION_PREFIX.length);
  if (scope === "all") return "all";
  return profiles.find((profile) => profile.scope === scope)?.scope ?? null;
}
