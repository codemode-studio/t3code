import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { CopyIcon, EyeIcon, FolderOpenIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useProjectFileQuery } from "../files/projectFilesQueryState";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { serverEnvironment } from "../../state/server";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { collectSettingsSkills, type SettingsSkill, type SkillEnvironment } from "./skillsCatalog";
import {
  discoverLocalSkillFiles,
  type ProjectSkillTarget,
  type SkillEnvironmentTarget,
} from "./projectSkillFiles";

function SkillPreview({ skill, cwd }: { skill: SettingsSkill; cwd: string }) {
  const file = useProjectFileQuery(skill.environmentId, cwd, skill.path);
  return (
    <DialogPopup className="flex max-h-[85dvh] w-full flex-col sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>{skill.name}</DialogTitle>
        <p className="break-all text-xs text-muted-foreground">{skill.path}</p>
      </DialogHeader>
      <div className="min-h-0 overflow-auto border-t px-6 py-4">
        {file.error ? (
          <p role="alert" className="text-sm text-destructive">
            {file.error}
          </p>
        ) : file.data ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
            {file.data.contents}
            {file.data.truncated ? "\n\nFile preview truncated." : ""}
          </pre>
        ) : (
          <p className="text-sm text-muted-foreground">Loading skill...</p>
        )}
      </div>
    </DialogPopup>
  );
}

export function SkillsSettings() {
  const { scope, connectedEnvironments } = useSettingsScope();
  const rootsByEnvironment = useMemo(() => {
    const roots = new Map<EnvironmentId, string[]>();
    for (const member of scope.members) {
      const existing = roots.get(member.environmentId) ?? [];
      existing.push(member.workspaceRoot);
      roots.set(member.environmentId, existing);
    }
    return roots;
  }, [scope.members]);
  const providerAtom = useMemo(
    () =>
      Atom.make((get): SkillEnvironment[] =>
        connectedEnvironments.map((environment) => ({
          environmentId: environment.environmentId,
          label: environment.label,
          providers: get(serverEnvironment.providersValueAtom(environment.environmentId)) ?? [],
          workspaceRoots: rootsByEnvironment.get(environment.environmentId) ?? [],
        })),
      ),
    [connectedEnvironments, rootsByEnvironment],
  );
  const environments = useAtomValue(providerAtom);
  const projectTargets = useMemo(
    (): ProjectSkillTarget[] =>
      connectedEnvironments.flatMap((environment) =>
        (rootsByEnvironment.get(environment.environmentId) ?? []).map((cwd) => ({
          environmentId: environment.environmentId,
          environmentLabel: environment.label,
          cwd,
        })),
      ),
    [connectedEnvironments, rootsByEnvironment],
  );
  const environmentTargets = useMemo(
    (): SkillEnvironmentTarget[] =>
      connectedEnvironments.map((environment) => ({
        environmentId: environment.environmentId,
        environmentLabel: environment.label,
      })),
    [connectedEnvironments],
  );
  const projectTargetKey = JSON.stringify([projectTargets, environmentTargets]);
  const [projectFiles, setProjectFiles] = useState<{ key: string; skills: SettingsSkill[] } | null>(
    null,
  );
  const skills = useMemo(() => {
    const byFile = new Map<string, SettingsSkill>();
    for (const skill of collectSettingsSkills(environments)) {
      byFile.set(JSON.stringify([skill.environmentId, skill.path.replaceAll("\\", "/")]), skill);
    }
    if (projectFiles?.key === projectTargetKey) {
      for (const skill of projectFiles.skills) {
        const key = JSON.stringify([skill.environmentId, skill.path.replaceAll("\\", "/")]);
        const existing = byFile.get(key);
        if (!existing || (existing.scope === "project" && skill.scope === "personal")) {
          byFile.set(key, skill);
        }
      }
    }
    return [...byFile.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
    );
  }, [environments, projectFiles, projectTargetKey]);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<SettingsSkill | null>(null);

  useEffect(() => {
    let active = true;
    void discoverLocalSkillFiles(projectTargets, environmentTargets, false).then((found) => {
      if (active) setProjectFiles({ key: projectTargetKey, skills: found });
    });
    return () => {
      active = false;
    };
  }, [projectTargets, environmentTargets, projectTargetKey]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const localSkills = discoverLocalSkillFiles(projectTargets, environmentTargets, true).then(
      (found) => {
        setProjectFiles({ key: projectTargetKey, skills: found });
      },
    );
    const requests: Promise<unknown>[] = [];
    for (const environment of environments) {
      for (const provider of environment.providers) {
        if (!provider.enabled || !provider.installed) continue;
        if (environment.workspaceRoots.length === 0) {
          requests.push(
            refreshProviders({
              environmentId: environment.environmentId,
              input: { instanceId: provider.instanceId },
            }),
          );
        }
        for (const cwd of environment.workspaceRoots) {
          requests.push(
            refreshProviders({
              environmentId: environment.environmentId,
              input: { instanceId: provider.instanceId, cwd, refreshWorkspace: true },
            }),
          );
        }
      }
    }
    const results = await Promise.all(requests);
    await localSkills;
    setRefreshing(false);
    if (
      results.some(
        (result) =>
          typeof result === "object" &&
          result !== null &&
          "_tag" in result &&
          result._tag === "Failure",
      )
    ) {
      toastManager.add({ type: "error", title: "Could not refresh some skills" });
    }
  }, [environments, projectTargets, environmentTargets, projectTargetKey, refreshProviders]);

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = skills.filter(
    (skill) =>
      !normalizedQuery ||
      [skill.name, skill.description, skill.path, skill.source, skill.environmentLabel].some(
        (value) => value.toLowerCase().includes(normalizedQuery),
      ),
  );
  const multipleEnvironments = environments.length > 1;
  const revealableEnvironments = new Set(
    connectedEnvironments
      .filter((environment) => environment.serverConfig?.shellRevealInFileManager === true)
      .map((environment) => environment.environmentId),
  );
  const previewCwd = preview
    ? (rootsByEnvironment.get(preview.environmentId)?.[0] ??
      preview.path
        .replaceAll("\\", "/")
        .slice(0, preview.path.replaceAll("\\", "/").lastIndexOf("/")))
    : "";

  return (
    <SettingsPageContainer width="wide">
      <section className="flex flex-col gap-2 px-3 sm:px-4">
        <h1 className="font-heading text-2xl font-semibold">Skills</h1>
        <p className="text-sm text-muted-foreground">
          File skills in your home folders and selected projects.
        </p>
      </section>
      <div className="flex items-center gap-3 px-3 sm:px-4">
        <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
          {filtered.length} {filtered.length === 1 ? "skill" : "skills"}
        </span>
        <Input
          nativeInput
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Filter"
          aria-label="Filter skills"
          className="min-w-0 flex-1"
        />
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Refresh skills"
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          <RefreshCwIcon className={refreshing ? "animate-spin" : undefined} />
        </Button>
      </div>
      <div className="overflow-hidden rounded-xl border">
        {filtered.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            {normalizedQuery ? "No matching skills" : "No file skills found for this selection"}
          </p>
        ) : (
          filtered.map((skill) => (
            <div
              key={JSON.stringify([skill.environmentId, skill.path])}
              className="flex flex-col gap-1 border-b px-4 py-3 last:border-b-0"
            >
              <div className="flex min-w-0 items-center gap-2">
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left text-sm font-medium hover:underline"
                  onClick={() => setPreview(skill)}
                >
                  {skill.name}
                </button>
                <Badge variant="secondary" size="sm">
                  {skill.scope === "project" ? "Project" : "Personal"}
                </Badge>
                <span className="w-20 shrink-0 truncate text-right text-xs text-muted-foreground">
                  {skill.source}
                </span>
              </div>
              {skill.description ? (
                <p className="truncate text-sm text-muted-foreground">{skill.description}</p>
              ) : null}
              <div className="flex min-w-0 items-center gap-1">
                <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {skill.path}
                </p>
                {multipleEnvironments ? (
                  <span className="max-w-24 truncate text-xs text-muted-foreground">
                    {skill.environmentLabel}
                  </span>
                ) : null}
                <Button
                  type="button"
                  size="icon-micro"
                  variant="ghost-muted"
                  aria-label={`Preview ${skill.name}`}
                  onClick={() => setPreview(skill)}
                >
                  <EyeIcon />
                </Button>
                <Button
                  type="button"
                  size="icon-micro"
                  variant="ghost-muted"
                  aria-label={`Copy path of ${skill.name}`}
                  onClick={() => {
                    void writeTextToClipboard(skill.path).catch(() =>
                      toastManager.add({ type: "error", title: "Could not copy skill path" }),
                    );
                  }}
                >
                  <CopyIcon />
                </Button>
                {revealableEnvironments.has(skill.environmentId) ? (
                  <Button
                    type="button"
                    size="icon-micro"
                    variant="ghost-muted"
                    aria-label={`Reveal ${skill.name} in file manager`}
                    onClick={() => {
                      void openInEditor({
                        environmentId: skill.environmentId,
                        input: { cwd: skill.path, editor: "file-manager", reveal: true },
                      }).then((result) => {
                        if (result._tag === "Failure")
                          toastManager.add({ type: "error", title: "Could not reveal skill" });
                      });
                    }}
                  >
                    <FolderOpenIcon />
                  </Button>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
      <Dialog
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
      >
        {preview ? <SkillPreview skill={preview} cwd={previewCwd} /> : null}
      </Dialog>
    </SettingsPageContainer>
  );
}
