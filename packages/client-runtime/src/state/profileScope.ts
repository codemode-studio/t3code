import type {
  EnvironmentId,
  ProjectId,
  ProviderProfileId,
  ServerSettings,
} from "@t3tools/contracts";

/**
 * What a client's thread list shows: every project, one profile's projects, or those without one.
 * Profile ids are slugs of user-chosen names, so a profile named "All" has the id `all`; tagging
 * profile values keeps them from ever meaning a special scope.
 */
export type ProfileScope = "all" | "unassigned" | `profile:${ProviderProfileId}`;

const PROFILE_SCOPE_PREFIX = "profile:";

export function profileScopeForId(id: ProviderProfileId): `profile:${ProviderProfileId}` {
  return `${PROFILE_SCOPE_PREFIX}${id}`;
}

/** The profile a scope selects, or null for "all" and "unassigned". */
export function profileIdOfScope(scope: ProfileScope): ProviderProfileId | null {
  return scope.startsWith(PROFILE_SCOPE_PREFIX)
    ? (scope.slice(PROFILE_SCOPE_PREFIX.length) as ProviderProfileId)
    : null;
}

export interface ProfileScopeProfile {
  readonly id: ProviderProfileId;
  readonly name: string;
  readonly color: string | null;
  /** Environments that define the profile, the primary first. */
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
}

type ProfileSettings = Pick<
  ServerSettings,
  "providerProfileId" | "providerProfiles" | "projectSettingsOverrides"
>;

/** `${environmentId}:${projectId}`, the key thread lists filter threads and drafts by. */
export function profileScopeProjectKey(environmentId: EnvironmentId, projectId: string): string {
  return `${environmentId}:${projectId}`;
}

/**
 * The profile a project uses on its own environment: its override, including an explicit
 * "no profile", else the environment default.
 */
export function resolveProjectProviderProfileId(
  settings: Pick<ServerSettings, "providerProfileId" | "projectSettingsOverrides">,
  projectId: ProjectId,
): ProviderProfileId | null {
  const entry = settings.projectSettingsOverrides[projectId];
  return entry !== undefined && Object.hasOwn(entry, "providerProfileId")
    ? (entry.providerProfileId ?? null)
    : settings.providerProfileId;
}

/** Like `resolveProjectProviderProfileId`, but an id whose profile was deleted means none. */
export function resolveProjectProfileId(
  settings: ProfileSettings,
  projectId: ProjectId,
): ProviderProfileId | null {
  const id = resolveProjectProviderProfileId(settings, projectId);
  return id !== null && settings.providerProfiles[id] !== undefined ? id : null;
}

/**
 * Profiles across environments, merged by id. Profiles are stored per environment, so one id is
 * treated as one company everywhere; the primary environment names and orders them like its
 * Profiles settings page, and profiles only other environments define follow.
 */
export function collectProfiles(
  settingsByEnvironment: ReadonlyArray<
    readonly [EnvironmentId, Pick<ServerSettings, "providerProfiles">]
  >,
  primaryEnvironmentId: EnvironmentId | null,
): ReadonlyArray<ProfileScopeProfile> {
  const ordered = [...settingsByEnvironment].sort(
    ([left], [right]) =>
      Number(right === primaryEnvironmentId) - Number(left === primaryEnvironmentId),
  );
  const byId = new Map<
    ProviderProfileId,
    ProfileScopeProfile & { environmentIds: EnvironmentId[] }
  >();
  for (const [environmentId, settings] of ordered) {
    for (const [id, profile] of Object.entries(settings.providerProfiles) as Array<
      [ProviderProfileId, ServerSettings["providerProfiles"][ProviderProfileId]]
    >) {
      const existing = byId.get(id);
      if (existing) existing.environmentIds.push(environmentId);
      else
        byId.set(id, {
          id,
          name: profile.name,
          color: profile.color ?? null,
          environmentIds: [environmentId],
        });
    }
  }
  return [...byId.values()];
}

/** Each project's profile, keyed by `profileScopeProjectKey`. */
export function buildProjectProfileMap(
  projects: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly id: ProjectId }>,
  settingsByEnvironment: ReadonlyMap<EnvironmentId, ProfileSettings>,
): ReadonlyMap<string, ProviderProfileId | null> {
  const map = new Map<string, ProviderProfileId | null>();
  for (const project of projects) {
    const settings = settingsByEnvironment.get(project.environmentId);
    map.set(
      profileScopeProjectKey(project.environmentId, project.id),
      settings ? resolveProjectProfileId(settings, project.id) : null,
    );
  }
  return map;
}

/**
 * Whether the Unassigned bucket has anything to show: a project without a profile on an
 * environment that defines profiles. An environment that never set profiles up has not opted in,
 * so its projects alone do not make one; they still show under "all".
 */
export function hasProjectsWithoutProfile(
  projects: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly id: ProjectId }>,
  settingsByEnvironment: ReadonlyMap<EnvironmentId, ProfileSettings>,
): boolean {
  return projects.some((project) => {
    const settings = settingsByEnvironment.get(project.environmentId);
    return (
      settings !== undefined &&
      Object.keys(settings.providerProfiles).length > 0 &&
      resolveProjectProfileId(settings, project.id) === null
    );
  });
}

/**
 * The scope to show for a stored choice. A choice that has nothing to show, a profile no
 * connected environment defines or "unassigned" once every project has a profile, shows
 * everything without forgetting the choice, so it returns when that changes back.
 */
export function resolveProfileScope(
  stored: string,
  profiles: ReadonlyArray<ProfileScopeProfile>,
  hasUnassignedProjects: boolean,
): ProfileScope {
  if (profiles.length === 0) return "all";
  if (stored === "unassigned") return hasUnassignedProjects ? "unassigned" : "all";
  if (!stored.startsWith(PROFILE_SCOPE_PREFIX)) return "all";
  const id = stored.slice(PROFILE_SCOPE_PREFIX.length);
  const profile = profiles.find((candidate) => candidate.id === id);
  return profile ? profileScopeForId(profile.id) : "all";
}

/** The scope that contains a project: its profile, or the unassigned bucket. */
function profileScopeOfProject(profileId: ProviderProfileId | null | undefined): ProfileScope {
  return profileId == null ? "unassigned" : profileScopeForId(profileId);
}

function projectMatchesScope(
  scope: ProfileScope,
  profileId: ProviderProfileId | null | undefined,
): boolean {
  if (scope === "all") return true;
  if (scope === "unassigned") return profileId == null;
  return profileId === profileIdOfScope(scope);
}

/** Project keys visible in a scope, or null when nothing is filtered. */
export function scopedProjectKeysForProfile(
  scope: ProfileScope,
  projectProfiles: ReadonlyMap<string, ProviderProfileId | null>,
): ReadonlySet<string> | null {
  if (scope === "all") return null;
  const keys = new Set<string>();
  for (const [key, profileId] of projectProfiles) {
    if (projectMatchesScope(scope, profileId)) keys.add(key);
  }
  return keys;
}

/**
 * Keys allowed by both filters, where null allows everything. A project group can span
 * environments whose members use different profiles, so choosing a project inside a profile keeps
 * only the members in that profile.
 */
export function intersectProjectKeys(
  left: ReadonlySet<string> | null,
  right: ReadonlySet<string> | null,
): ReadonlySet<string> | null {
  if (left === null) return right;
  if (right === null) return left;
  return new Set([...left].filter((key) => right.has(key)));
}

/** Where the user is: the thread or draft the route shows, and the project it belongs to. */
export interface ProfileNavigation {
  /** Identifies the thread or draft, so opening another thread of the same project counts. */
  readonly routeKey: string;
  readonly projectKey: string;
}

export type ProfileNavigationOutcome =
  /** The project's profile is not known yet; ask again when projects load. */
  | { readonly kind: "pending" }
  /** Nothing new, or the scope already shows the project. */
  | { readonly kind: "stay" }
  | { readonly kind: "switch"; readonly scope: ProfileScope };

/**
 * Follows navigation, not the scope: opening a thread or draft, or moving a draft to another
 * project, shows that project's profile. A profile picked by hand holds until the next navigation.
 */
export function followNavigation(input: {
  readonly followed: ProfileNavigation | null;
  readonly current: ProfileNavigation;
  readonly scope: ProfileScope;
  readonly projectProfiles: ReadonlyMap<string, ProviderProfileId | null>;
}): ProfileNavigationOutcome {
  const { followed, current } = input;
  if (followed?.routeKey === current.routeKey && followed.projectKey === current.projectKey) {
    return { kind: "stay" };
  }
  if (!input.projectProfiles.has(current.projectKey)) return { kind: "pending" };
  const profileId = input.projectProfiles.get(current.projectKey);
  return projectMatchesScope(input.scope, profileId)
    ? { kind: "stay" }
    : { kind: "switch", scope: profileScopeOfProject(profileId) };
}

/** Two letters for a profile avatar: initials of the first two words, else the first two letters. */
export function profileMonogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}
