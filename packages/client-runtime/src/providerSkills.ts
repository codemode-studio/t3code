import {
  isProviderWorkspaceSnapshotCurrent,
  type ServerProvider,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";

export type ProviderSkillSourceKind = "app" | "repo" | "project" | "personal" | "system" | "other";

function normalizePathSeparators(pathValue: string): string {
  return pathValue.replaceAll("\\", "/");
}

export function dedupeProviderSkillsByName(
  skills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSkill[] {
  const seenNames = new Set<string>();
  return skills.filter((skill) => {
    const normalizedName = skill.name.trim().toLowerCase();
    if (seenNames.has(normalizedName)) {
      return false;
    }
    seenNames.add(normalizedName);
    return true;
  });
}

/**
 * Whether a composer pick can start this skill. A skill switched off in the
 * provider's settings will not run, and one the provider reserves for the
 * agent (Claude Code's `user-invocable: false`) rejects a user invocation.
 * Everything else, including skills the agent may not start on its own, is
 * fair game: the server dispatches the pick in the provider's native form.
 */
export function isProviderSkillUserInvocable(
  skill: Pick<ServerProviderSkill, "enabled" | "userInvocable">,
): boolean {
  return skill.enabled && skill.userInvocable !== false;
}

export function getProviderSkillsForSlashMenu(
  skills: ReadonlyArray<ServerProviderSkill>,
  showSkillsInSlashMenu: boolean,
): ServerProviderSkill[] {
  return showSkillsInSlashMenu
    ? dedupeProviderSkillsByName(skills.filter(isProviderSkillUserInvocable))
    : [];
}

export function getProviderSlashCommandsForSlashMenu(
  slashCommands: ReadonlyArray<ServerProviderSlashCommand>,
  visibleSkills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSlashCommand[] {
  const skillNames = new Set(visibleSkills.map((skill) => skill.name.trim().toLowerCase()));
  return slashCommands.filter((command) => !skillNames.has(command.name.trim().toLowerCase()));
}

export function resolveProviderSkillSourceKind(
  skill: Pick<ServerProviderSkill, "path" | "scope">,
): ProviderSkillSourceKind {
  const normalizedPath = normalizePathSeparators(skill.path);
  if (normalizedPath.includes("/.codex/plugins/") || normalizedPath.includes("/.agents/plugins/")) {
    return "app";
  }

  const normalizedScope = skill.scope?.trim().toLowerCase();
  switch (normalizedScope) {
    case "repo":
    case "repository":
      return "repo";
    case "project":
    case "workspace":
    case "local":
      return "project";
    case "user":
    case "personal":
      return "personal";
    case "system":
      return "system";
    case undefined:
    case "":
      return "other";
    default:
      return "other";
  }
}

function resolveProviderWorkspaceSnapshot(
  provider: ServerProvider,
  cwd: string | null | undefined,
) {
  if (!cwd) return undefined;
  return provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd);
}

export function hasCompleteProviderWorkspaceSnapshot(
  provider: ServerProvider | null | undefined,
  cwd: string | null | undefined,
): boolean {
  const snapshot = provider && resolveProviderWorkspaceSnapshot(provider, cwd);
  return Boolean(snapshot && !snapshot.slashCommandsPending);
}

/** A complete snapshot young enough that opening a composer need not rescan. */
export function hasCurrentProviderWorkspaceSnapshot(
  provider: ServerProvider | null | undefined,
  cwd: string | null | undefined,
  nowMs: number,
): boolean {
  const snapshot = provider && resolveProviderWorkspaceSnapshot(provider, cwd);
  return Boolean(
    snapshot &&
    !snapshot.slashCommandsPending &&
    isProviderWorkspaceSnapshotCurrent(snapshot, nowMs),
  );
}

export function resolveProviderSkillsForCwd(
  provider: ServerProvider,
  cwd: string | null | undefined,
): ServerProvider["skills"] {
  return resolveProviderWorkspaceSnapshot(provider, cwd)?.skills ?? provider.skills;
}

export function resolveProviderSlashCommandsForCwd(
  provider: ServerProvider,
  cwd: string | null | undefined,
): ServerProvider["slashCommands"] {
  return resolveProviderWorkspaceSnapshot(provider, cwd)?.slashCommands ?? provider.slashCommands;
}

/** Windows paths compare without case; POSIX paths preserve it. */
export function normalizeSkillVisibilityPath(path: string): string {
  const normalized = normalizePathSeparators(path);
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

/** Expand or remove every known alias together so re-enabling reverses hiding. */
export function setSkillPathVisibility(
  hiddenPaths: readonly string[],
  aliases: readonly string[],
  visible: boolean,
): string[] {
  const normalizedAliases = new Set(aliases.map(normalizeSkillVisibilityPath));
  const normalizedHidden = hiddenPaths.map(normalizeSkillVisibilityPath);
  return visible
    ? normalizedHidden.filter((path) => !normalizedAliases.has(path))
    : [...new Set([...normalizedHidden, ...normalizedAliases])];
}

/** Hide a file from both skill pickers and matching native slash-command entries. */
export function applySkillVisibility(
  skills: ReadonlyArray<ServerProviderSkill>,
  slashCommands: ReadonlyArray<ServerProviderSlashCommand>,
  hiddenPaths: ReadonlyArray<string>,
) {
  if (hiddenPaths.length === 0) return { skills, slashCommands };
  const hidden = new Set(hiddenPaths.map(normalizeSkillVisibilityPath));
  const hiddenNames = new Set(
    skills
      .filter((skill) => hidden.has(normalizeSkillVisibilityPath(skill.path)))
      .map((skill) => skill.name.toLowerCase()),
  );
  return {
    skills: skills.filter((skill) => !hidden.has(normalizeSkillVisibilityPath(skill.path))),
    slashCommands: slashCommands.filter((command) => !hiddenNames.has(command.name.toLowerCase())),
  };
}
