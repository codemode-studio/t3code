import type { EnvironmentId, FileSkill } from "@t3tools/contracts";
import { executeAtomQuery, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { projectEnvironment } from "../../state/projects";

export interface SettingsSkill extends FileSkill {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}
export interface SkillEnvironmentTarget {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly workspaceRoots: readonly string[];
}

/** One metadata request per environment. File bodies are loaded only for preview. */
export async function discoverLocalSkillFiles(
  targets: readonly SkillEnvironmentTarget[],
  refresh: boolean,
  signal?: AbortSignal,
) {
  const results = await Promise.all(
    targets.map(async (target) => {
      const errors: string[] = [];
      if (refresh && !signal?.aborted) {
        const providers =
          appAtomRegistry.get(serverEnvironment.providersValueAtom(target.environmentId)) ?? [];
        await Promise.all(
          providers.map(async (provider) => {
            if (!provider.enabled || !provider.installed || signal?.aborted) return;
            const roots =
              target.workspaceRoots.length > 0
                ? target.workspaceRoots
                : (provider.workspaceSnapshots ?? []).map((snapshot) => snapshot.cwd);
            const inputs = [
              ...(target.workspaceRoots.length === 0 ? [{ instanceId: provider.instanceId }] : []),
              ...roots.map((cwd) => ({
                instanceId: provider.instanceId,
                cwd,
                refreshWorkspace: true,
              })),
            ];
            for (const input of inputs) {
              if (signal?.aborted) break;
              const refreshed = await runAtomCommand(
                appAtomRegistry,
                serverEnvironment.refreshProviders,
                { environmentId: target.environmentId, input },
                { reportFailure: false },
              );
              if (refreshed._tag !== "Success")
                errors.push(
                  `${target.environmentLabel}: Could not refresh ${provider.driver} skills`,
                );
            }
          }),
        );
      }
      const result = await executeAtomQuery(
        appAtomRegistry,
        projectEnvironment.listSkills({
          environmentId: target.environmentId,
          input: { workspaceRoots: target.workspaceRoots },
        }),
        { refresh, ...(signal ? { signal } : {}), reportFailure: false },
      );
      if (result._tag !== "Success")
        return {
          skills: [] as SettingsSkill[],
          errors: [...errors, `Could not load skills from ${target.environmentLabel}`],
        };
      return {
        skills: result.value.skills.map((skill) => ({
          ...skill,
          environmentId: target.environmentId,
          environmentLabel: target.environmentLabel,
        })),
        errors: [
          ...errors,
          ...result.value.errors.map((error) => `${target.environmentLabel}: ${error}`),
        ],
      };
    }),
  );
  return {
    skills: results
      .flatMap((result) => result.skills)
      .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)),
    errors: results.flatMap((result) => result.errors),
  };
}
