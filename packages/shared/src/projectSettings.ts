import {
  isProviderAvailable,
  type ModelSelection,
  PROJECT_FILE_BACKED_SETTINGS,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  type ProjectFileBackedSettingKey,
  type ProjectId,
  type ProjectScopedServerSettingKey,
  type ProjectSettingsOverrides,
  type ProviderInstanceId,
  type ProviderProfile,
  type ProviderProfileId,
  resolveProjectProviderInstanceEnabled,
  type ResolvedServerSettings,
  type ServerProvider,
  type ServerSettings,
  type T3ProjectFile,
  type ThreadEnvMode,
  type WorktreeCleanupRules,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "./path.ts";
import { fallbackTextGenerationModelSelection } from "./serverSettings.ts";

export type ProjectSettingSource = "environment" | "project" | "t3.json";

export type ProjectSettingSources = Readonly<
  Record<ProjectScopedServerSettingKey, ProjectSettingSource>
>;

export interface ResolvedProjectSettings<Settings extends ServerSettings = ServerSettings> {
  readonly settings: Settings;
  readonly sources: ProjectSettingSources;
  readonly overrides: ProjectSettingsOverrides;
}

const EMPTY_OVERRIDES: ProjectSettingsOverrides = {};

const ENVIRONMENT_SOURCES: ProjectSettingSources = Object.fromEntries(
  PROJECT_SCOPED_SERVER_SETTING_KEYS.map((key) => [key, "environment"]),
) as Record<ProjectScopedServerSettingKey, ProjectSettingSource>;

export function hasProjectSettingsOverrides(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
): boolean {
  for (const entry of Object.values(settings.projectSettingsOverrides)) {
    // A forward-compatible decode can leave an unknown value as a present
    // undefined; that is not an override.
    if (Object.values(entry).some((value) => value !== undefined)) return true;
  }
  return false;
}

/**
 * The project aggregate's own model and workspace fields. They remain the
 * source of truth until the server has folded them into the override record;
 * after the fold the record alone decides, so a reset there cannot be undone
 * by a stale aggregate value.
 */
export interface LegacyProjectSettingsFields {
  readonly defaultModelSelection?: ModelSelection | null | undefined;
  readonly defaultThreadEnvMode?: ThreadEnvMode | null | undefined;
}

export function resolveProjectSettings(
  settings: ServerSettings,
  projectId: ProjectId | null,
  project?: LegacyProjectSettingsFields | null,
): ResolvedProjectSettings;
export function resolveProjectSettings(
  settings: ServerSettings,
  projectId: ProjectId | null,
  project: LegacyProjectSettingsFields | null | undefined,
  projectFile: T3ProjectFile | null,
): ResolvedProjectSettings<ResolvedServerSettings>;
export function resolveProjectSettings(
  settings: ServerSettings,
  projectId: ProjectId | null,
  project?: LegacyProjectSettingsFields | null,
  projectFile?: T3ProjectFile | null,
): ResolvedProjectSettings {
  const resolved = applyProviderProfileDefaultModel(
    resolveProjectOverrides(settings, projectId, project),
    projectId,
  );
  return projectFile === undefined ? resolved : applyProjectFile(resolved, projectFile);
}

function applyProjectFile(
  resolved: ResolvedProjectSettings,
  projectFile: T3ProjectFile | null,
): ResolvedProjectSettings {
  let effective: Record<string, unknown> | null = null;
  let sources: Record<ProjectScopedServerSettingKey, ProjectSettingSource> | null = null;
  for (const key of Object.keys(PROJECT_FILE_BACKED_SETTINGS) as ProjectFileBackedSettingKey[]) {
    if (resolved.settings[key] !== null) continue;
    const { value, source } = resolveProjectFileBackedSetting(key, null, projectFile);
    effective ??= { ...resolved.settings };
    sources ??= { ...resolved.sources };
    effective[key] = value;
    sources[key] = source;
  }
  return effective === null || sources === null
    ? resolved
    : { ...resolved, settings: effective as ServerSettings, sources };
}

export function resolveProjectFileBackedSetting<K extends ProjectFileBackedSettingKey>(
  key: K,
  setting: ServerSettings[K],
  projectFile: T3ProjectFile | null,
): { value: ResolvedServerSettings[K]; source: ProjectSettingSource } {
  if (setting !== null) {
    return { value: setting as ResolvedServerSettings[K], source: "environment" };
  }
  const { field, builtIn } = PROJECT_FILE_BACKED_SETTINGS[key];
  const fromFile = projectFile?.[field] as ResolvedServerSettings[K] | undefined;
  return fromFile === undefined
    ? { value: builtIn as ResolvedServerSettings[K], source: "environment" }
    : { value: fromFile, source: "t3.json" };
}

function resolveProjectOverrides(
  settings: ServerSettings,
  projectId: ProjectId | null,
  project?: LegacyProjectSettingsFields | null,
): ResolvedProjectSettings {
  const stored = projectId === null ? undefined : settings.projectSettingsOverrides[projectId];
  const overrides: ProjectSettingsOverrides =
    project == null || settings.projectSettingsFolded
      ? (stored ?? EMPTY_OVERRIDES)
      : {
          ...(project.defaultModelSelection != null
            ? { defaultModelSelection: project.defaultModelSelection }
            : {}),
          ...(project.defaultThreadEnvMode != null
            ? { defaultThreadEnvMode: project.defaultThreadEnvMode }
            : {}),
          ...stored,
        };
  if (Object.keys(overrides).length === 0) {
    return { settings, sources: ENVIRONMENT_SOURCES, overrides: EMPTY_OVERRIDES };
  }
  const sources: Record<ProjectScopedServerSettingKey, ProjectSettingSource> = {
    ...ENVIRONMENT_SOURCES,
  };
  const effective: Record<string, unknown> = { ...settings };
  for (const key of PROJECT_SCOPED_SERVER_SETTING_KEYS) {
    if (!Object.hasOwn(overrides, key)) continue;
    const value = overrides[key];
    // A forward-compatible decode leaves an unknown value as a present
    // undefined; that is not an override.
    if (value === undefined) continue;
    if (
      (key === "textGenerationModelSelection" || key === "defaultModelSelection") &&
      value !== undefined &&
      value !== null &&
      !resolveProjectProviderInstanceEnabled(
        settings,
        projectId,
        (value as ModelSelection).instanceId,
      )
    ) {
      continue;
    }
    effective[key] = value;
    sources[key] = "project";
  }
  const textGeneration = effective.textGenerationModelSelection as ModelSelection;
  if (!resolveProjectProviderInstanceEnabled(settings, projectId, textGeneration.instanceId)) {
    const fallback = fallbackTextGenerationModelSelection(
      settings.providerInstances,
      (instanceId) => resolveProjectProviderInstanceEnabled(settings, projectId, instanceId),
      {
        includeConfiguredInstances: true,
        defaultModelSelection: effective.defaultModelSelection as ModelSelection | null,
      },
    );
    if (fallback !== null) effective.textGenerationModelSelection = fallback;
  }
  return { settings: effective as ServerSettings, sources, overrides };
}

export interface ResolvedProviderProfile extends ProviderProfile {
  readonly id: ProviderProfileId;
  /** The profile's instance ids as a set, for membership checks in pickers. */
  readonly instanceIdSet: ReadonlySet<ProviderInstanceId>;
}

/**
 * The profile selected by already-resolved settings (see
 * `resolveProjectSettings`), or null when every provider is offered. A
 * dangling id, left behind by a deleted profile, also means no profile.
 */
export function resolveProviderProfile(
  settings: Pick<ServerSettings, "providerProfileId" | "providerProfiles">,
): ResolvedProviderProfile | null {
  const id = settings.providerProfileId;
  const profile = id === null ? undefined : settings.providerProfiles[id];
  if (id === null || profile === undefined) return null;
  return { ...profile, id, instanceIdSet: new Set(profile.instanceIds) };
}

/**
 * Profiles a multi-target settings edit can assign: those every target
 * defines under the same id. Profiles are per environment, so writing an id
 * a target lacks would silently mean "no profile" there. Names come from the
 * first target.
 */
export function commonProviderProfiles(
  targets: ReadonlyArray<Pick<ServerSettings, "providerProfiles">>,
): ReadonlyArray<readonly [ProviderProfileId, ProviderProfile]> {
  const [first, ...rest] = targets;
  if (!first) return [];
  return (
    Object.entries(first.providerProfiles) as Array<[ProviderProfileId, ProviderProfile]>
  ).filter(([id]) => rest.every((target) => target.providerProfiles[id] !== undefined));
}

/**
 * The model to use when a profile applies but nothing picked one: the default
 * model of the profile's first ready instance, else its first one that is not
 * failing. Never a provider outside the profile, so a run cannot fall back to
 * another account. Null when no profile instance can start.
 */
export function resolveProviderProfileFallbackModelSelection(
  profile: Pick<ProviderProfile, "instanceIds">,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null {
  const candidates = profile.instanceIds.flatMap((instanceId) => {
    const provider = providers.find((candidate) => candidate.instanceId === instanceId);
    return provider?.enabled && isProviderAvailable(provider) ? [provider] : [];
  });
  const provider =
    candidates.find((candidate) => candidate.status === "ready") ??
    candidates.find((candidate) => candidate.status !== "error");
  const model =
    provider?.models.find((candidate) => candidate.isDefault && !candidate.isCustom) ??
    provider?.models.find((candidate) => !candidate.isCustom) ??
    provider?.models[0];
  return provider && model ? { instanceId: provider.instanceId, model: model.slug } : null;
}

/**
 * A profile replaces the inherited new-thread model: its own default when it
 * has one, otherwise the environment default only if the profile includes
 * that provider. A project's explicit model override always wins.
 */
function applyProviderProfileDefaultModel(
  resolved: ResolvedProjectSettings,
  projectId: ProjectId | null,
): ResolvedProjectSettings {
  if (resolved.sources.defaultModelSelection === "project") return resolved;
  const profile = resolveProviderProfile(resolved.settings);
  if (profile === null) return resolved;
  const inherited = resolved.settings.defaultModelSelection;
  const profileDefault = profile.defaultModelSelection;
  const next =
    profileDefault !== null &&
    profile.instanceIdSet.has(profileDefault.instanceId) &&
    resolveProjectProviderInstanceEnabled(resolved.settings, projectId, profileDefault.instanceId)
      ? profileDefault
      : inherited !== null && profile.instanceIdSet.has(inherited.instanceId)
        ? inherited
        : null;
  return next === inherited
    ? resolved
    : { ...resolved, settings: { ...resolved.settings, defaultModelSelection: next } };
}

/**
 * A project the environment made from just a name (a folder directly inside
 * `ServerConfig.newProjectsRoot`) has only its first commit, so until it has a
 * thread, a new thread works in the project checkout even when the environment
 * default is a new worktree.
 */
export function resolveNewThreadEnvMode(input: {
  readonly projectSettings: ResolvedProjectSettings<ResolvedServerSettings>;
  readonly workspaceRoot: string | null;
  readonly newProjectsRoot: string | null | undefined;
  readonly projectHasThreads: boolean;
}): ThreadEnvMode {
  const configured = input.projectSettings.settings.defaultThreadEnvMode;
  if (
    configured === "local" ||
    input.projectHasThreads ||
    input.projectSettings.sources.defaultThreadEnvMode !== "environment" ||
    input.workspaceRoot === null ||
    input.newProjectsRoot == null
  ) {
    return configured;
  }
  const root = normalizeProjectPathForComparison(input.newProjectsRoot);
  const folder = normalizeProjectPathForComparison(input.workspaceRoot);
  const separator = root.includes("\\") ? "\\" : "/";
  const prefix = root.endsWith(separator) ? root : `${root}${separator}`;
  const isNewProjectFolder =
    folder.startsWith(prefix) &&
    folder.length > prefix.length &&
    !folder.slice(prefix.length).includes(separator);
  return isNewProjectFolder ? "local" : configured;
}

export function withProjectSettingsOverrides(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
  projectId: ProjectId,
  next: ProjectSettingsOverrides | null,
): ServerSettings["projectSettingsOverrides"] {
  const { [projectId]: _removed, ...rest } = settings.projectSettingsOverrides;
  return next === null || Object.keys(next).length === 0 ? rest : { ...rest, [projectId]: next };
}

export function clearProjectSettingsOverrides(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
  projectId: ProjectId,
  keys: readonly ProjectScopedServerSettingKey[],
): ProjectSettingsOverrides | null {
  const current = settings.projectSettingsOverrides[projectId];
  if (current === undefined) return null;
  const next = { ...current };
  for (const key of keys) delete next[key];
  return Object.keys(next).length === 0 ? null : next;
}

export function resolveWorktreeCleanup(
  settings: ServerSettings,
  projectId: ProjectId | null,
): WorktreeCleanupRules {
  const policy = resolveProjectSettings(settings, projectId).settings.worktreeCleanup;
  if (policy?.mode === "custom") return policy.rules;
  if (policy?.mode === "off")
    return {
      worktreeKeepWhen: settings.storageCleanup.worktreeKeepWhen,
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
    };
  const {
    worktreeKeepWhen,
    worktreeAfterDays,
    worktreeSettledAfterDays,
    worktreeOnMerge,
    worktreeOnDelete,
    worktreeUnchanged,
  } = settings.storageCleanup;
  return {
    worktreeKeepWhen,
    worktreeAfterDays,
    worktreeSettledAfterDays,
    worktreeOnMerge,
    worktreeOnDelete,
    worktreeUnchanged,
  };
}
