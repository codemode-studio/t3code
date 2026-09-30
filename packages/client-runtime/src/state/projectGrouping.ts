import { scopedProjectKey, scopeProjectRef } from "../environment/scoped.ts";
import type {
  EnvironmentId,
  ScopedProjectRef,
  SidebarProjectGroupingMode,
} from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";

import type { EnvironmentProject } from "./models.ts";
import { normalizeProjectPathForComparison } from "./projects.ts";

export interface ProjectGroupingSettings {
  readonly sidebarProjectGroupingMode: SidebarProjectGroupingMode;
  readonly sidebarProjectGroupingOverrides: Record<string, SidebarProjectGroupingMode>;
}

export type ProjectGroupingMode = SidebarProjectGroupingMode;

export function selectProjectGroupingSettings(settings: ClientSettings): ProjectGroupingSettings {
  return {
    sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: settings.sidebarProjectGroupingOverrides,
  };
}

function uniqueNonEmptyValues(values: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

function deriveRepositoryRelativeProjectPath(
  project: Pick<EnvironmentProject, "workspaceRoot" | "repositoryIdentity">,
): string | null {
  const rootPath = project.repositoryIdentity?.rootPath?.trim();
  if (!rootPath) {
    return null;
  }

  const normalizedProjectPath = normalizeProjectPathForComparison(project.workspaceRoot);
  const normalizedRootPath = normalizeProjectPathForComparison(rootPath);
  if (normalizedProjectPath.length === 0 || normalizedRootPath.length === 0) {
    return null;
  }

  if (normalizedProjectPath === normalizedRootPath) {
    return "";
  }

  const separator = normalizedRootPath.includes("\\") ? "\\" : "/";
  const rootPrefix = `${normalizedRootPath}${separator}`;
  if (!normalizedProjectPath.startsWith(rootPrefix)) {
    return null;
  }

  return normalizedProjectPath.slice(rootPrefix.length).replaceAll("\\", "/");
}

export function derivePhysicalProjectKeyFromPath(environmentId: string, cwd: string): string {
  return `${environmentId}:${normalizeProjectPathForComparison(cwd)}`;
}

export function derivePhysicalProjectKey(
  project: Pick<EnvironmentProject, "environmentId" | "workspaceRoot">,
): string {
  return derivePhysicalProjectKeyFromPath(project.environmentId, project.workspaceRoot);
}

export function deriveProjectGroupingOverrideKey(
  project: Pick<EnvironmentProject, "environmentId" | "workspaceRoot">,
): string {
  return derivePhysicalProjectKey(project);
}

export function getProjectOrderKey(
  project: Pick<EnvironmentProject, "environmentId" | "workspaceRoot">,
): string {
  return derivePhysicalProjectKey(project);
}

export function resolveProjectGroupingMode(
  project: Pick<EnvironmentProject, "environmentId" | "workspaceRoot">,
  settings: ProjectGroupingSettings,
): SidebarProjectGroupingMode {
  return (
    settings.sidebarProjectGroupingOverrides?.[deriveProjectGroupingOverrideKey(project)] ??
    settings.sidebarProjectGroupingMode
  );
}

/**
 * Keys that identify a project's repository across environments, preferred key
 * first. Servers before `groupKey` report only `canonicalKey`, so two projects
 * are the same repository when they share any key.
 */
function deriveRepositoryKeys(
  project: Pick<EnvironmentProject, "repositoryIdentity"> | null | undefined,
): ReadonlyArray<string> {
  const identity = project?.repositoryIdentity;
  if (!identity) return [];
  return identity.groupKey && identity.groupKey !== identity.canonicalKey
    ? [identity.groupKey, identity.canonicalKey]
    : [identity.canonicalKey];
}

export function sharesRepository(
  left: Pick<EnvironmentProject, "repositoryIdentity"> | null | undefined,
  right: Pick<EnvironmentProject, "repositoryIdentity"> | null | undefined,
): boolean {
  const rightKeys = deriveRepositoryKeys(right);
  return deriveRepositoryKeys(left).some((key) => rightKeys.includes(key));
}

function deriveRepositoryScopedKeys(
  project: Pick<EnvironmentProject, "workspaceRoot" | "repositoryIdentity">,
  groupingMode: SidebarProjectGroupingMode,
): ReadonlyArray<string> {
  const repositoryKeys = deriveRepositoryKeys(project);
  if (groupingMode === "repository") return repositoryKeys;

  const relativeProjectPath = deriveRepositoryRelativeProjectPath(project);
  return relativeProjectPath
    ? repositoryKeys.map((key) => `${key}::${relativeProjectPath}`)
    : repositoryKeys;
}

export function deriveLogicalProjectKey(
  project: Pick<
    EnvironmentProject,
    "environmentId" | "id" | "workspaceRoot" | "repositoryIdentity"
  >,
  options?: {
    readonly groupingMode?: SidebarProjectGroupingMode;
  },
): string {
  const groupingMode = options?.groupingMode ?? "repository";
  if (groupingMode === "separate") {
    return derivePhysicalProjectKey(project);
  }

  return (
    deriveRepositoryScopedKeys(project, groupingMode)[0] ??
    derivePhysicalProjectKey(project) ??
    scopedProjectKey(scopeProjectRef(project.environmentId, project.id))
  );
}

export function deriveLogicalProjectKeyFromSettings(
  project: Pick<
    EnvironmentProject,
    "environmentId" | "id" | "workspaceRoot" | "repositoryIdentity"
  >,
  settings: ProjectGroupingSettings,
): string {
  return deriveLogicalProjectKey(project, {
    groupingMode: resolveProjectGroupingMode(project, settings),
  });
}

export function deriveProjectGroupLabel(input: {
  readonly representative: Pick<EnvironmentProject, "title" | "repositoryIdentity">;
  readonly members: ReadonlyArray<Pick<EnvironmentProject, "title" | "repositoryIdentity">>;
}): string {
  const sharedTitles = uniqueNonEmptyValues(input.members.map((member) => member.title));
  const sharedDisplayNames = uniqueNonEmptyValues(
    input.members.map((member) => member.repositoryIdentity?.displayName),
  );
  const sharedRepositoryNames = uniqueNonEmptyValues(
    input.members.map((member) => member.repositoryIdentity?.name),
  );
  const sharedTitle = sharedTitles[0];
  if (
    sharedTitles.length === 1 &&
    sharedTitle !== undefined &&
    !sharedDisplayNames.includes(sharedTitle) &&
    !sharedRepositoryNames.includes(sharedTitle)
  ) {
    return sharedTitle;
  }
  if (sharedDisplayNames.length === 1) {
    return sharedDisplayNames[0]!;
  }

  if (sharedRepositoryNames.length === 1) {
    return sharedRepositoryNames[0]!;
  }

  return input.representative.title;
}

export interface ProjectGroupMember<TProject extends EnvironmentProject = EnvironmentProject> {
  readonly physicalProjectKey: string;
  readonly project: TProject;
}

export interface ProjectGroup<TProject extends EnvironmentProject = EnvironmentProject> {
  readonly key: string;
  readonly label: string;
  readonly representative: TProject;
  readonly members: ReadonlyArray<ProjectGroupMember<TProject>>;
  readonly memberProjectRefs: ReadonlyArray<ScopedProjectRef>;
}

function projectFreshnessTime(project: EnvironmentProject): number {
  const updatedAtTime = Date.parse(project.updatedAt);
  if (Number.isFinite(updatedAtTime)) {
    return updatedAtTime;
  }
  const createdAtTime = Date.parse(project.createdAt);
  return Number.isFinite(createdAtTime) ? createdAtTime : 0;
}

function shouldReplacePhysicalProjectWinner<TProject extends EnvironmentProject>(
  existing: TProject,
  candidate: TProject,
): boolean {
  const freshnessDelta = projectFreshnessTime(candidate) - projectFreshnessTime(existing);
  return freshnessDelta > 0 || (freshnessDelta === 0 && candidate.id > existing.id);
}

function selectProjectIdentitySource<TProject extends EnvironmentProject>(
  projects: ReadonlyArray<TProject>,
  winner: TProject,
): TProject {
  if (winner.repositoryIdentity !== null) {
    return winner;
  }

  let freshestIdentifiedProject: TProject | null = null;
  for (const project of projects) {
    if (project.repositoryIdentity === null) {
      continue;
    }
    if (
      freshestIdentifiedProject === null ||
      shouldReplacePhysicalProjectWinner(freshestIdentifiedProject, project)
    ) {
      freshestIdentifiedProject = project;
    }
  }
  return freshestIdentifiedProject ?? winner;
}

/**
 * Builds logical project groups without losing the physical projects that
 * remain the actual navigation and task-creation targets.
 *
 * Presentation-specific metadata, filtering, and activity sorting stay in
 * each client. Grouping modes, overrides, physical deduplication, labels, and
 * member preservation live here so web and mobile cannot drift.
 */
export function buildProjectGroups<TProject extends EnvironmentProject>(input: {
  readonly projects: ReadonlyArray<TProject>;
  readonly settings: ProjectGroupingSettings;
  readonly preferredEnvironmentId?: EnvironmentId | null;
}): ReadonlyArray<ProjectGroup<TProject>> {
  const projectsByPhysicalKey = new Map<string, TProject[]>();
  for (const project of input.projects) {
    const physicalProjectKey = derivePhysicalProjectKey(project);
    const existing = projectsByPhysicalKey.get(physicalProjectKey);
    if (existing) {
      existing.push(project);
    } else {
      projectsByPhysicalKey.set(physicalProjectKey, [project]);
    }
  }

  // Projects whose repository keys overlap share a group even when their
  // preferred keys differ, as when only one environment's server sends `groupKey`.
  const parentByLogicalKey = new Map<string, string>();
  const findRoot = (logicalKey: string): string => {
    const parent = parentByLogicalKey.get(logicalKey);
    return parent === undefined ? logicalKey : findRoot(parent);
  };
  const logicalKeyByRepositoryKey = new Map<string, string>();
  const entries: Array<{
    readonly logicalKey: string;
    readonly member: ProjectGroupMember<TProject>;
  }> = [];
  for (const [physicalProjectKey, physicalProjects] of projectsByPhysicalKey) {
    const winner = physicalProjects.reduce((current, candidate) =>
      shouldReplacePhysicalProjectWinner(current, candidate) ? candidate : current,
    );
    const identitySource = selectProjectIdentitySource(physicalProjects, winner);
    const groupingMode = resolveProjectGroupingMode(winner, input.settings);
    const logicalKey = deriveLogicalProjectKey(identitySource, { groupingMode });
    if (groupingMode !== "separate") {
      for (const repositoryKey of deriveRepositoryScopedKeys(identitySource, groupingMode)) {
        const owner = logicalKeyByRepositoryKey.get(repositoryKey);
        if (owner === undefined) {
          logicalKeyByRepositoryKey.set(repositoryKey, logicalKey);
          continue;
        }
        const ownerRoot = findRoot(owner);
        const root = findRoot(logicalKey);
        if (ownerRoot !== root) parentByLogicalKey.set(root, ownerRoot);
      }
    }
    entries.push({ logicalKey, member: { physicalProjectKey, project: winner } });
  }

  const entriesByRoot = new Map<string, (typeof entries)[number][]>();
  for (const entry of entries) {
    const root = findRoot(entry.logicalKey);
    const existing = entriesByRoot.get(root);
    if (existing) {
      existing.push(entry);
    } else {
      entriesByRoot.set(root, [entry]);
    }
  }

  // A merged group keeps the preferred environment's key, which is the key its
  // local project derives on its own.
  const preferredEnvironmentId = input.preferredEnvironmentId ?? null;
  const logicalKeyByPhysicalKey = new Map<string, string>();
  const groupedMembers = new Map<string, ProjectGroupMember<TProject>[]>();
  for (const groupEntries of entriesByRoot.values()) {
    const representativeEntry =
      (preferredEnvironmentId
        ? groupEntries.find(
            (entry) => entry.member.project.environmentId === preferredEnvironmentId,
          )
        : undefined) ?? groupEntries[0]!;
    for (const entry of groupEntries) {
      logicalKeyByPhysicalKey.set(entry.member.physicalProjectKey, representativeEntry.logicalKey);
    }
    groupedMembers.set(
      representativeEntry.logicalKey,
      groupEntries.map((entry) => entry.member),
    );
  }

  const projectRefsByLogicalKey = new Map<string, ScopedProjectRef[]>();
  const seenProjectRefs = new Set<string>();
  for (const project of input.projects) {
    const physicalProjectKey = derivePhysicalProjectKey(project);
    const logicalKey =
      logicalKeyByPhysicalKey.get(physicalProjectKey) ??
      deriveLogicalProjectKeyFromSettings(project, input.settings);
    const projectRefKey = scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
    if (seenProjectRefs.has(projectRefKey)) continue;
    seenProjectRefs.add(projectRefKey);
    const projectRef = scopeProjectRef(project.environmentId, project.id);
    const existing = projectRefsByLogicalKey.get(logicalKey);
    if (existing) {
      existing.push(projectRef);
    } else {
      projectRefsByLogicalKey.set(logicalKey, [projectRef]);
    }
  }

  return Array.from(groupedMembers, ([key, members]) => {
    const representative =
      (preferredEnvironmentId
        ? members.find((member) => member.project.environmentId === preferredEnvironmentId)?.project
        : null) ?? members[0]!.project;
    return {
      key,
      label:
        members.length > 1
          ? deriveProjectGroupLabel({
              representative,
              members: members.map((member) => member.project),
            })
          : representative.title,
      representative,
      members,
      memberProjectRefs: projectRefsByLogicalKey.get(key) ?? [],
    };
  });
}
