import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  buildProjectProfileMap,
  collectProfiles,
  resolveProfileScope,
  scopedProjectKeysForProfile,
  type ProfileScope,
} from "@t3tools/client-runtime/state/profile-scope";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { environmentServerConfigsAtom } from "../../state/server";
import { buildHomeProfileFilterOptions } from "./home-profile-scope";

/**
 * The thread list's provider profile filter, shared by the compact Home list and the
 * iPad sidebar. The choice is a device preference, so it survives restarts and layout
 * changes; a profile no connected environment defines shows every thread.
 */
export function useHomeProfileScope(projects: ReadonlyArray<EnvironmentProject>) {
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const settingsByEnvironment = useMemo(
    () => new Map([...serverConfigs].map(([id, config]) => [id, config.settings] as const)),
    [serverConfigs],
  );
  // Mobile has no primary environment; the first environment that defines an id names it.
  const profiles = useMemo(
    () => collectProfiles([...settingsByEnvironment], null),
    [settingsByEnvironment],
  );
  const projectProfiles = useMemo(
    () => buildProjectProfileMap(projects, settingsByEnvironment),
    [projects, settingsByEnvironment],
  );
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const storedScope = AsyncResult.isSuccess(preferences)
    ? (preferences.value.threadListProfileScope ?? "all")
    : "all";
  const hasUnassignedProjects = useMemo(
    () => [...projectProfiles.values()].some((profileId) => profileId === null),
    [projectProfiles],
  );
  const scope = resolveProfileScope(storedScope, profiles, hasUnassignedProjects);
  const options = useMemo(
    () => buildHomeProfileFilterOptions({ profiles, hasUnassignedProjects }),
    [hasUnassignedProjects, profiles],
  );
  const scopedProjectKeys = useMemo(
    () => scopedProjectKeysForProfile(scope, projectProfiles),
    [projectProfiles, scope],
  );
  const setScope = useCallback(
    (next: ProfileScope) => savePreferences({ threadListProfileScope: next }),
    [savePreferences],
  );
  const selectedLabel =
    scope === "all" ? null : (options.find((option) => option.scope === scope)?.label ?? null);
  return { options, scope, scopedProjectKeys, selectedLabel, setScope } as const;
}
