import {
  profileScopeForId,
  type ProfileScopeProfile,
} from "@t3tools/client-runtime/state/profile-scope";

import type { HomeListFilterMenuProfile } from "./home-list-filter-menu";

/**
 * The thread list's profile choices besides "All profiles": each profile, then "Unassigned" when
 * some project has none. Empty when no environment defines a profile, which hides the filter. A
 * stored "Unassigned" with nothing left in it resolves to all profiles (`resolveProfileScope`),
 * so the menu never shows a choice it no longer lists.
 */
export function buildHomeProfileFilterOptions(input: {
  readonly profiles: ReadonlyArray<ProfileScopeProfile>;
  readonly hasUnassignedProjects: boolean;
}): ReadonlyArray<HomeListFilterMenuProfile> {
  if (input.profiles.length === 0) return [];
  const options: HomeListFilterMenuProfile[] = input.profiles.map((profile) => ({
    scope: profileScopeForId(profile.id),
    label: profile.name,
    color: profile.color,
  }));
  if (input.hasUnassignedProjects) {
    options.push({ scope: "unassigned", label: "Unassigned", color: null });
  }
  return options;
}
