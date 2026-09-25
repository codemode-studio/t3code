import type {
  ServerProvider,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";

export type ProviderSkillSourceKind = "app" | "repo" | "project" | "personal" | "system" | "other";

function titleCaseWords(value: string): string {
  const words: string[] = [];
  for (const segment of value.split(/[\s:_-]+/)) {
    if (segment.length === 0) continue;
    words.push(segment.charAt(0).toUpperCase() + segment.slice(1));
  }
  return words.join(" ");
}

function normalizePathSeparators(pathValue: string): string {
  return pathValue.replaceAll("\\", "/");
}

export function formatProviderSkillDisplayName(
  skill: Pick<ServerProviderSkill, "name" | "displayName">,
): string {
  const displayName = skill.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  return titleCaseWords(skill.name);
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
