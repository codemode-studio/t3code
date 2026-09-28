import {
  type ProjectId,
  type ProjectSettingsOverrides,
  type ProviderProfile,
  ProviderProfileId,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { clearProjectSettingsOverrides } from "@t3tools/shared/projectSettings";

export const PROVIDER_PROFILE_COLORS = [
  "#ea580c",
  "#2563eb",
  "#16a34a",
  "#9333ea",
  "#db2777",
  "#0891b2",
] as const;

/** A readable id derived from the name, suffixed until it is unused in `existing`. */
export function providerProfileIdFromName(
  name: string,
  existing: Readonly<Record<string, unknown>>,
): ProviderProfileId {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "profile";
  let candidate = base;
  for (let suffix = 2; Object.hasOwn(existing, candidate); suffix += 1) {
    candidate = `${base}-${suffix}`;
  }
  return ProviderProfileId.make(candidate);
}

/**
 * Removes a profile and every reference to it in one write: the environment
 * default and project overrides that select it fall back to their inherited
 * value instead of silently pointing at nothing.
 */
export function buildDeleteProviderProfilePatch(
  settings: Pick<ServerSettings, "providerProfileId" | "projectSettingsOverrides">,
  id: ProviderProfileId,
): ServerSettingsPatch {
  const overrides: Record<ProjectId, ProjectSettingsOverrides | null> = {};
  for (const [projectId, entry] of Object.entries(settings.projectSettingsOverrides) as [
    ProjectId,
    ProjectSettingsOverrides,
  ][]) {
    if (entry.providerProfileId === id) {
      overrides[projectId] = clearProjectSettingsOverrides(settings, projectId, [
        "providerProfileId",
      ]);
    }
  }
  return {
    providerProfiles: { [id]: null },
    ...(settings.providerProfileId === id ? { providerProfileId: null } : {}),
    ...(Object.keys(overrides).length > 0 ? { projectSettingsOverrides: overrides } : {}),
  };
}

/**
 * Makes a project use `target` (a profile, or `null` for every provider) with the smallest
 * override: none when the environment default already gives it, else an explicit one. Other
 * overrides on the project are kept.
 */
export function buildProjectProfilePatch(
  settings: Pick<ServerSettings, "providerProfileId" | "projectSettingsOverrides">,
  projectId: ProjectId,
  target: ProviderProfileId | null,
): ServerSettingsPatch {
  const next =
    target === settings.providerProfileId
      ? clearProjectSettingsOverrides(settings, projectId, ["providerProfileId"])
      : { ...settings.projectSettingsOverrides[projectId], providerProfileId: target };
  return { projectSettingsOverrides: { [projectId]: next } };
}

/**
 * Saves a new profile in one write, with the projects picked for it and, optionally, as the
 * profile projects without their own use.
 */
export function buildCreateProviderProfilePatch(
  settings: Pick<ServerSettings, "providerProfileId" | "projectSettingsOverrides">,
  input: {
    readonly id: ProviderProfileId;
    readonly profile: ProviderProfile;
    readonly projectIds: ReadonlyArray<ProjectId>;
    readonly makeDefault: boolean;
  },
): ServerSettingsPatch {
  const next = input.makeDefault ? { ...settings, providerProfileId: input.id } : settings;
  const overrides: Record<ProjectId, ProjectSettingsOverrides | null> = {};
  for (const projectId of input.projectIds) {
    Object.assign(
      overrides,
      buildProjectProfilePatch(next, projectId, input.id).projectSettingsOverrides,
    );
  }
  return {
    providerProfiles: { [input.id]: input.profile },
    ...(input.makeDefault ? { providerProfileId: input.id } : {}),
    ...(Object.keys(overrides).length > 0 ? { projectSettingsOverrides: overrides } : {}),
  };
}

// Kept importable from here for the settings screens; the shared client runtime owns it so web
// and mobile resolve a project's profile identically.
export { resolveProjectProviderProfileId } from "@t3tools/client-runtime/state/profile-scope";

/**
 * Select values for the profile picker. Profile ids are user-derived slugs
 * (a profile named "None" gets id `none`), so they are prefixed to never
 * collide with the opt-out value.
 */
export const NO_PROVIDER_PROFILE_VALUE = "no-profile";
const PROFILE_VALUE_PREFIX = "profile:";

export function encodeProviderProfileValue(id: ProviderProfileId | null): string {
  return id === null ? NO_PROVIDER_PROFILE_VALUE : `${PROFILE_VALUE_PREFIX}${id}`;
}

/** `null` is the opt-out; `undefined` is a value this picker never produces. */
export function decodeProviderProfileValue(value: string): ProviderProfileId | null | undefined {
  if (value === NO_PROVIDER_PROFILE_VALUE) return null;
  return value.startsWith(PROFILE_VALUE_PREFIX)
    ? ProviderProfileId.make(value.slice(PROFILE_VALUE_PREFIX.length))
    : undefined;
}
