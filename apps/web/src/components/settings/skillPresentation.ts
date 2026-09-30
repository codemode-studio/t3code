import type { SettingsSkill, SkillEnvironmentTarget } from "./projectSkillFiles";

export type SkillSourceKey =
  | "agents"
  | "claude"
  | "codex"
  | "cursor"
  | "opencode"
  | "grok"
  | "antigravity"
  | "other";

/** Folder families and provider drivers that report skills, keyed to one presentation. */
const SOURCE_KEYS: Readonly<Record<string, SkillSourceKey>> = {
  agents: "agents",
  claude: "claude",
  claudeAgent: "claude",
  codex: "codex",
  cursor: "cursor",
  opencode: "opencode",
  grok: "grok",
  antigravity: "antigravity",
};

export function skillSourceKey(source: string): SkillSourceKey {
  return SOURCE_KEYS[source] ?? "other";
}

function normalize(path: string) {
  return path.replaceAll("\\", "/").replace(/\/+$/u, "");
}

/**
 * The shortest trailing part of a project root that no other selected root in its environment
 * ends with, so `~/Git/app` and `~/work/app` read as `Git/app` and `work/app`.
 */
function projectLabel(root: string, roots: ReadonlyArray<string>) {
  const segments = normalize(root).split("/");
  const others = roots.map(normalize).filter((other) => other !== normalize(root));
  for (let count = 1; count < segments.length; count++) {
    const suffix = segments.slice(-count).join("/");
    if (!others.some((other) => other === suffix || other.endsWith(`/${suffix}`))) return suffix;
  }
  return normalize(root);
}

/** The project root that holds a project skill, or null for personal skills and strays. */
function skillProjectRoot(
  skill: Pick<SettingsSkill, "environmentId" | "path" | "scope">,
  targets: ReadonlyArray<Pick<SkillEnvironmentTarget, "environmentId" | "workspaceRoots">>,
): string | null {
  if (skill.scope !== "project") return null;
  const path = normalize(skill.path);
  const roots = targets
    .filter((target) => target.environmentId === skill.environmentId)
    .flatMap((target) => target.workspaceRoots)
    .filter((root) => path.startsWith(`${normalize(root)}/`));
  // The deepest root wins when projects nest.
  return roots.toSorted((left, right) => right.length - left.length)[0] ?? null;
}

// Generated folder names, like the account IDs Claude uses for skills it syncs from claude.ai.
const GENERATED_SEGMENT = /^[\da-f]{8}-[\da-f-]{20,}$/iu;

function collapseGeneratedSegments(path: string) {
  return path
    .split("/")
    .map((segment) => (GENERATED_SEGMENT.test(segment.split("_")[0] ?? "") ? "…" : segment))
    .join("/");
}

/**
 * A short location for a row: `~/.agents/skills/review` for personal skills and
 * `project/.claude/skills/review` for project skills. The file name is implied.
 */
export function skillDisplayPath(
  skill: Pick<SettingsSkill, "path">,
  project: { readonly root: string; readonly label: string } | null,
) {
  const path = normalize(skill.path).replace(/\/SKILL\.md$/iu, "");
  if (project !== null) {
    return collapseGeneratedSegments(
      `${project.label}/${path.slice(normalize(project.root).length + 1)}`,
    );
  }
  // Personal skills live in a dot-folder of the server's home, which this client does not know.
  const segments = path.split("/");
  const dotFolder = segments.findIndex((segment) => segment.startsWith("."));
  return collapseGeneratedSegments(
    dotFolder > 0 ? `~/${segments.slice(dotFolder).join("/")}` : path,
  );
}

export interface SkillGroup {
  readonly key: string;
  readonly label: string;
  readonly kind: "personal" | "project";
  readonly environmentLabel: string | null;
  readonly skills: ReadonlyArray<SettingsSkill & { readonly displayPath: string }>;
}

/**
 * Personal skills first, then one group per project, each per environment when more than one
 * environment is in scope. Projects that share a folder name are labeled by enough of their
 * path to tell them apart. Skills keep their incoming order within a group.
 */
export function groupSkills(
  skills: ReadonlyArray<SettingsSkill>,
  targets: ReadonlyArray<
    Pick<SkillEnvironmentTarget, "environmentId" | "environmentLabel" | "workspaceRoots">
  >,
): SkillGroup[] {
  const multipleEnvironments = targets.length > 1;
  const groups = new Map<
    string,
    {
      key: string;
      label: string;
      kind: "personal" | "project";
      environmentLabel: string | null;
      skills: Array<SettingsSkill & { readonly displayPath: string }>;
    }
  >();
  for (const skill of skills) {
    const projectRoot = skillProjectRoot(skill, targets);
    const project =
      projectRoot === null
        ? null
        : {
            root: projectRoot,
            label: projectLabel(
              projectRoot,
              targets
                .filter((target) => target.environmentId === skill.environmentId)
                .flatMap((target) => target.workspaceRoots),
            ),
          };
    const kind = project === null ? "personal" : "project";
    const key = JSON.stringify([skill.environmentId, projectRoot]);
    const group = groups.get(key) ?? {
      key,
      label: project?.label ?? "Personal",
      kind,
      environmentLabel: multipleEnvironments ? skill.environmentLabel : null,
      skills: [],
    };
    group.skills.push({ ...skill, displayPath: skillDisplayPath(skill, project) });
    groups.set(key, group);
  }
  return [...groups.values()].toSorted(
    (left, right) =>
      Number(left.kind === "project") - Number(right.kind === "project") ||
      (left.environmentLabel ?? "").localeCompare(right.environmentLabel ?? "") ||
      left.label.localeCompare(right.label),
  );
}
