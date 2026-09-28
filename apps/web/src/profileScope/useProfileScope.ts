import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ProviderProfileId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useMemo } from "react";

import { useLocalStorage } from "../hooks/useLocalStorage";
import { useProjects, useThreadShells } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { environmentServerConfigsAtom } from "../state/server";
import { useUiStateStore } from "../uiStateStore";
import {
  buildProjectProfileMap,
  collectProfiles,
  resolveProfileScope,
  scopedProjectKeysForProfile,
  type ProfileScope,
  type ProfileScopeProfile,
} from "@t3tools/client-runtime/state/profile-scope";
import { countAttentionByProfile } from "./profileScope.logic";

// Device-local like the project filter: each client picks the company it is looking at.
const PROFILE_SCOPE_STORAGE_KEY = "t3code:profile-scope:v1";

/** Profiles, each project's profile, and the scope the sidebar is showing. */
export function useProfileScopeState() {
  const projects = useProjects();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const settingsByEnvironment = useMemo(
    () => new Map([...serverConfigs].map(([id, config]) => [id, config.settings] as const)),
    [serverConfigs],
  );
  const profiles = useMemo(
    () => collectProfiles([...settingsByEnvironment], primaryEnvironmentId),
    [primaryEnvironmentId, settingsByEnvironment],
  );
  const projectProfiles = useMemo(
    () => buildProjectProfileMap(projects, settingsByEnvironment),
    [projects, settingsByEnvironment],
  );
  const [storedScope, setStoredScope] = useLocalStorage(
    PROFILE_SCOPE_STORAGE_KEY,
    "all",
    Schema.String,
  );
  const scope = resolveProfileScope(storedScope, profiles);
  const setScope = useCallback((next: ProfileScope) => setStoredScope(next), [setStoredScope]);
  const hasUnassignedProjects = useMemo(
    () => [...projectProfiles.values()].some((profileId) => profileId === null),
    [projectProfiles],
  );
  const activeProfile: ProfileScopeProfile | null =
    profiles.find((profile) => profile.id === scope) ?? null;
  return {
    profiles,
    projectProfiles,
    scope,
    setScope,
    activeProfile,
    hasUnassignedProjects,
  };
}

/** Project keys the sidebar shows for the active profile, or null when it shows everything. */
export function useProfileScopedProjectKeys(): ReadonlySet<string> | null {
  const { scope, projectProfiles } = useProfileScopeState();
  return useMemo(
    () => scopedProjectKeysForProfile(scope, projectProfiles),
    [projectProfiles, scope],
  );
}

/** Threads waiting on the user per profile id; `null` counts projects without a profile. */
export function useProfileAttentionCounts(
  projectProfiles: ReadonlyMap<string, ProviderProfileId | null>,
): ReadonlyMap<ProviderProfileId | null, number> {
  const threads = useThreadShells();
  const lastVisitedAtByThreadKey = useUiStateStore((store) => store.threadLastVisitedAtById);
  return useMemo(
    () =>
      countAttentionByProfile({
        threads,
        projectProfiles,
        lastVisitedAtByThreadKey,
        threadKey: (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      }),
    [lastVisitedAtByThreadKey, projectProfiles, threads],
  );
}
