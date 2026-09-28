import type {
  EnvironmentId,
  ProjectId,
  ProviderProfileId,
  ServerSettings,
} from "@t3tools/contracts";

/** What a client's thread list shows: every project, one profile's projects, or those without one. */
export type ProfileScope = "all" | "unassigned" | ProviderProfileId;

export interface ProfileScopeProfile {
  readonly id: ProviderProfileId;
  readonly name: string;
  readonly color: string | null;
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
 * Profiles across environments, merged by id and sorted by name. Profiles are stored per
 * environment, so one id is treated as one company everywhere; the primary environment names it.
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
  const byId = new Map<ProviderProfileId, ProfileScopeProfile>();
  for (const [, settings] of ordered) {
    for (const [id, profile] of Object.entries(settings.providerProfiles) as Array<
      [ProviderProfileId, ServerSettings["providerProfiles"][ProviderProfileId]]
    >) {
      if (!byId.has(id)) byId.set(id, { id, name: profile.name, color: profile.color ?? null });
    }
  }
  return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
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
 * The scope to show for a stored choice. A profile no connected environment defines shows
 * everything, without forgetting the choice, so it returns when that environment reconnects.
 */
export function resolveProfileScope(
  stored: string,
  profiles: ReadonlyArray<ProfileScopeProfile>,
): ProfileScope {
  if (profiles.length === 0) return "all";
  if (stored === "all" || stored === "unassigned") return stored;
  const profile = profiles.find((candidate) => candidate.id === stored);
  return profile ? profile.id : "all";
}

/** The scope that contains a project: its profile, or the unassigned bucket. */
export function profileScopeOfProject(
  profileId: ProviderProfileId | null | undefined,
): ProfileScope {
  return profileId ?? "unassigned";
}

export function projectMatchesScope(
  scope: ProfileScope,
  profileId: ProviderProfileId | null | undefined,
): boolean {
  if (scope === "all") return true;
  if (scope === "unassigned") return profileId == null;
  return profileId === scope;
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

/** Two letters for a profile avatar: initials of the first two words, else the first two letters. */
export function profileMonogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}
