import type { EnvironmentId, ServerProvider, ServerProviderSkill } from "@t3tools/contracts";

export interface SettingsSkill {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly source: string;
  readonly scope: "personal" | "project";
  readonly enabled: boolean;
}

export interface SkillEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly workspaceRoots: ReadonlyArray<string>;
}

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/, "");
}

function isWithin(path: string, root: string): boolean {
  const normalizedRoot = normalizedPath(root);
  return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`);
}

function isHomeAgentsSkill(path: string): boolean {
  return /^(?:\/(?:home|Users)\/[^/]+|[a-zA-Z]:\/Users\/[^/]+)\/\.agents\/skills\//.test(path);
}

function isHomeProviderSkill(path: string): boolean {
  return /^(?:\/(?:home|Users)\/[^/]+|[a-zA-Z]:\/Users\/[^/]+)\/\.(?:codex|claude|cursor|grok|opencode|pi|omp|fx|hermes|gemini|agent)\//.test(
    path,
  );
}

function skillScope(skill: ServerProviderSkill, roots: ReadonlyArray<string>) {
  const path = normalizedPath(skill.path);
  if (
    ["system", "builtin", "built-in"].includes(skill.scope?.toLowerCase() ?? "") ||
    path.includes("/skills/.system/")
  ) {
    return null;
  }
  if (isHomeAgentsSkill(path) || isHomeProviderSkill(path)) return "personal";
  if (roots.some((root) => isWithin(path, root))) return "project";
  if (
    /\/\.(?:agents|agent|codex|claude|cursor|grok|opencode|pi|omp|fx|hermes|gemini)\/.*?skills\//.test(
      path,
    )
  )
    return null;
  if (
    ["project", "repo", "repository", "workspace", "local"].includes(
      skill.scope?.toLowerCase() ?? "",
    )
  ) {
    return null;
  }
  return "personal";
}

function skillSource(path: string, provider: ServerProvider): string {
  const match = normalizedPath(path).match(
    /\/(?:\.(agents|codex|claude|cursor|grok|opencode|pi|omp|fx|hermes|antigravity)|\.gemini\/antigravity)\/.*?skills\//,
  );
  return match?.[1] ?? (path.includes("/.gemini/antigravity/") ? "antigravity" : provider.driver);
}

/** One row per file and environment. Provider inventories may report the same file twice. */
export function collectSettingsSkills(
  environments: ReadonlyArray<SkillEnvironment>,
): SettingsSkill[] {
  const byFile = new Map<string, SettingsSkill>();
  for (const environment of environments) {
    for (const provider of environment.providers) {
      if (!provider.enabled || !provider.installed) continue;
      const skills = [...provider.skills];
      for (const root of environment.workspaceRoots) {
        const snapshot = provider.workspaceSnapshots?.find((candidate) => candidate.cwd === root);
        if (snapshot) skills.push(...snapshot.skills);
      }
      for (const skill of skills) {
        const scope = skillScope(skill, environment.workspaceRoots);
        if (!scope || (scope === "project" && environment.workspaceRoots.length === 0)) continue;
        const path = normalizedPath(skill.path);
        const key = JSON.stringify([environment.environmentId, path]);
        if (byFile.has(key)) continue;
        byFile.set(key, {
          environmentId: environment.environmentId,
          environmentLabel: environment.label,
          name: skill.name,
          description: skill.shortDescription ?? skill.description ?? "",
          path: skill.path,
          source: skillSource(path, provider),
          scope,
          enabled: skill.enabled,
        });
      }
    }
  }
  return [...byFile.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.environmentLabel.localeCompare(b.environmentLabel) ||
      a.path.localeCompare(b.path),
  );
}
