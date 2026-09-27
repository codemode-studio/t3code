import {
  type ProjectId,
  type ProjectSettingsOverrides,
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

/** The profile a project uses: its own override, including an explicit "no profile", else the environment's. */
export function resolveProjectProviderProfileId(
  settings: Pick<ServerSettings, "providerProfileId" | "projectSettingsOverrides">,
  projectId: ProjectId,
): ProviderProfileId | null {
  const entry = settings.projectSettingsOverrides[projectId];
  return entry !== undefined && Object.hasOwn(entry, "providerProfileId")
    ? (entry.providerProfileId ?? null)
    : settings.providerProfileId;
}
