import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { resolveEnvironmentMachineKind, type ProviderProfileId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useMemo } from "react";

import { useLocalStorage } from "../hooks/useLocalStorage";
import { useProjects, useThreadShells } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { environmentServerConfigsAtom } from "../state/server";
import { useUiStateStore } from "../uiStateStore";
import {
  buildProjectProfileMap,
  collectProfiles,
  hasProjectsWithoutProfile,
  profileIdOfScope,
  resolveProfileScope,
  scopedProjectKeysForProfile,
  type ProfileScope,
  type ProfileScopeProfile,
} from "@t3tools/client-runtime/state/profile-scope";
import { countAttentionByProfile } from "./profileScope.logic";

// Device-local like the project filter: each client picks the company it is looking at.
// v2 tags profile values (`profile:<id>`); a v1 value could be a profile id equal to a special scope.
const PROFILE_SCOPE_STORAGE_KEY = "t3code:profile-scope:v2";

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
  const hasUnassignedProjects = useMemo(
    () => hasProjectsWithoutProfile(projects, settingsByEnvironment),
    [projects, settingsByEnvironment],
  );
  const scope = resolveProfileScope(storedScope, profiles, hasUnassignedProjects);
  const setScope = useCallback((next: ProfileScope) => setStoredScope(next), [setStoredScope]);
  const activeProfileId = profileIdOfScope(scope);
  const activeProfile: ProfileScopeProfile | null =
    profiles.find((profile) => profile.id === activeProfileId) ?? null;
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

/**
 * Environments whose settings this client knows, so whose profiles it can list: the primary
 * first, then by name. More than one means a profile can live on several machines.
 */
export function useProfileEnvironments() {
  const { environments } = useEnvironments();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return useMemo(
    () =>
      environments
        .flatMap((environment) => {
          const config = serverConfigs.get(environment.environmentId);
          return config
            ? [
                {
                  environmentId: environment.environmentId,
                  label: environment.label,
                  machine: resolveEnvironmentMachineKind(config),
                },
              ]
            : [];
        })
        .toSorted(
          (left, right) =>
            Number(right.environmentId === primaryEnvironmentId) -
              Number(left.environmentId === primaryEnvironmentId) ||
            left.label.localeCompare(right.label),
        ),
    [environments, primaryEnvironmentId, serverConfigs],
  );
}
