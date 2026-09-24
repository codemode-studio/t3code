import type { EnvironmentId } from "@t3tools/contracts";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { filesystemEnvironment } from "../../state/filesystem";
import { projectEnvironment } from "../../state/projects";
import type { SettingsSkill } from "./skillsCatalog";

const SKILL_FOLDERS = [
  [".agents/skills", "agents"],
  [".claude/skills", "claude"],
  [".cursor/skills", "cursor"],
  [".codex/skills", "codex"],
  [".opencode/skills", "opencode"],
  [".grok/skills", "grok"],
  [".pi/skills", "pi"],
  [".omp/skills", "omp"],
  [".fx/skills", "fx"],
  [".hermes/skills", "hermes"],
  [".gemini/skills", "antigravity"],
  [".agent/skills", "antigravity"],
] as const;

const PERSONAL_SKILL_FOLDERS = [
  ...SKILL_FOLDERS,
  [".pi/agent/skills", "pi"],
  [".omp/agent/skills", "omp"],
  [".gemini/config/skills", "antigravity"],
  [".gemini/antigravity-cli/skills", "antigravity"],
] as const;

export interface ProjectSkillTarget {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly cwd: string;
}

export interface SkillEnvironmentTarget {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}

function descriptionFromSkill(contents: string): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents.slice(0, 16_384))?.[1];
  const value = /^description:\s*(.+)$/m.exec(frontmatter ?? "")?.[1]?.trim() ?? "";
  return value.replace(/^(['"])(.*)\1$/, "$2");
}

/** Read immediate skill folders in each home and selected checkout. Missing roots are ordinary. */
export async function discoverLocalSkillFiles(
  projectTargets: ReadonlyArray<ProjectSkillTarget>,
  environments: ReadonlyArray<SkillEnvironmentTarget>,
  refresh: boolean,
): Promise<SettingsSkill[]> {
  const skills: SettingsSkill[] = [];
  const homeTargets = (
    await Promise.all(
      environments.map(async (environment) => {
        const result = await executeAtomQuery(
          appAtomRegistry,
          filesystemEnvironment.browse({
            environmentId: environment.environmentId,
            input: { partialPath: "~/" },
          }),
          { refresh, reportFailure: false, reportDefect: false },
        );
        return result._tag === "Success"
          ? { ...environment, cwd: result.value.parentPath, scope: "personal" as const }
          : null;
      }),
    )
  ).filter((target) => target !== null);
  const targets = [
    ...projectTargets.map((target) => ({ ...target, scope: "project" as const })),
    ...homeTargets,
  ];
  const listings = await Promise.all(
    targets.flatMap((target) =>
      (target.scope === "personal" ? PERSONAL_SKILL_FOLDERS : SKILL_FOLDERS).map(
        async ([folder, source]) => {
          const result = await executeAtomQuery(
            appAtomRegistry,
            projectEnvironment.listEntries({
              environmentId: target.environmentId,
              input: { cwd: target.cwd, directoryPath: folder },
            }),
            { refresh, reportFailure: false, reportDefect: false },
          );
          return { target, source, entries: result._tag === "Success" ? result.value.entries : [] };
        },
      ),
    ),
  );
  const candidates = listings
    .flatMap(({ target, source, entries }) =>
      entries
        .filter((entry) => entry.kind === "directory" && !entry.path.includes("/skills/.system"))
        .map((entry) => ({ target, source, entry })),
    )
    .slice(0, 300);
  for (let offset = 0; offset < candidates.length; offset += 8) {
    await Promise.all(
      candidates.slice(offset, offset + 8).map(async ({ target, source, entry }) => {
        const relativePath = `${entry.path}/SKILL.md`;
        const file = await executeAtomQuery(
          appAtomRegistry,
          projectEnvironment.readFile({
            environmentId: target.environmentId,
            input: { cwd: target.cwd, relativePath },
          }),
          { refresh, reportFailure: false, reportDefect: false },
        );
        if (file._tag !== "Success") return;
        const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
        const path = `${target.cwd.replace(/[\\/]+$/, "")}/${relativePath}`;
        skills.push({
          environmentId: target.environmentId,
          environmentLabel: target.environmentLabel,
          name,
          description: descriptionFromSkill(file.value.contents),
          path,
          source,
          scope: target.scope,
          enabled: true,
        });
      }),
    );
  }
  return skills;
}
