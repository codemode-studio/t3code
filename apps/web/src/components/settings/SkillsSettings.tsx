import { normalizeSkillVisibilityPath } from "@t3tools/client-runtime/providerSkills";
import {
  CopyIcon,
  EyeIcon,
  FolderOpenIcon,
  PlusIcon,
  SearchIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { useProjectFileQuery } from "../files/projectFilesQueryState";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { useSkillVisibility } from "../../hooks/useSkillVisibility";
import { Switch } from "../ui/switch";
import { AddSkillDialog } from "./AddSkillDialog";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { RefreshIcon } from "../ui/refresh-icon";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  discoverLocalSkillFiles,
  type SettingsSkill,
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
  const targets: SkillEnvironmentTarget[] = connectedEnvironments.map((environment) => ({
    environmentId: environment.environmentId,
    environmentLabel: environment.label,
    workspaceRoots: scope.members
      .filter((member) => member.environmentId === environment.environmentId)
      .map((member) => member.workspaceRoot),
  }));
  // Scope objects also change on provider status updates; those must not trigger disk scans.
  const targetKey = JSON.stringify(targets);
  const [revision, setRevision] = useState(0);
  const [catalog, setCatalog] = useState<{
    key: string;
    revision: number;
    skills: SettingsSkill[];
    errors: string[];
  } | null>(null);
  const { hiddenByEnvironment, setVisible } = useSkillVisibility();
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<SettingsSkill | null>(null);
  const [adding, setAdding] = useState(false);
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const refreshing = catalog?.key !== targetKey || catalog.revision !== revision;
  const skills = catalog?.key === targetKey ? catalog.skills : [];
  const errors = catalog?.key === targetKey ? catalog.errors : [];
  useEffect(() => {
    const controller = new AbortController();
    const selectedTargets: SkillEnvironmentTarget[] = JSON.parse(targetKey);
    void discoverLocalSkillFiles(selectedTargets, revision > 0, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setCatalog({ key: targetKey, revision, ...result });
      },
    );
    return () => {
      controller.abort();
    };
  }, [targetKey, revision]);

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = skills.filter(
    (skill) =>
      !normalizedQuery ||
      [skill.name, skill.description, skill.path, skill.source, skill.environmentLabel].some(
        (value) => value.toLowerCase().includes(normalizedQuery),
      ),
  );
  const multipleEnvironments = targets.length > 1;
  const revealableEnvironments = new Set(
    connectedEnvironments
      .filter((environment) => environment.serverConfig?.shellRevealInFileManager === true)
      .map((environment) => environment.environmentId),
  );
  const previewCwd = preview
    ? preview.path
        .replaceAll("\\", "/")
        .slice(0, preview.path.replaceAll("\\", "/").lastIndexOf("/"))
    : "";

  return (
    <SettingsPageContainer width="wide">
      <SettingsSection
        title="Skills"
        headerAction={
          <div className="flex items-center gap-1.5">
            <span className="text-2xs tabular-nums text-muted-foreground">
              {filtered.length} {filtered.length === 1 ? "skill" : "skills"}
            </span>
            <InputGroup className="w-48">
              <InputGroupAddon>
                <SearchIcon aria-hidden className="size-3" />
              </InputGroupAddon>
              <InputGroupInput
                type="search"
                size="sm"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setQuery("");
                }}
                placeholder="Search skills"
                aria-label="Search skills"
              />
            </InputGroup>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label="Refresh skills"
                    disabled={refreshing}
                    onClick={() => setRevision((value) => value + 1)}
                  >
                    <RefreshIcon refreshing={refreshing} />
                  </Button>
                }
              />
              <TooltipPopup side="top">Refresh skills</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label="Add skill"
                    disabled={targets.length === 0}
                    onClick={() => setAdding(true)}
                  >
                    <PlusIcon />
                  </Button>
                }
              />
              <TooltipPopup side="top">Add skill</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        {errors.map((error) => (
          <p
            key={error}
            role="alert"
            className="flex items-center gap-2 px-4 py-2.5 text-xs text-warning-foreground"
          >
            <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-warning" />
            {error}
          </p>
        ))}
        {filtered.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            {refreshing
              ? "Loading skills..."
              : normalizedQuery
                ? "No matching skills"
                : "No skills in your home folders or selected projects"}
          </p>
        ) : (
          filtered.map((skill) => {
            const visible = !skill.aliases.some((alias) =>
              (hiddenByEnvironment[skill.environmentId] ?? []).some(
                (hidden) =>
                  normalizeSkillVisibilityPath(hidden) === normalizeSkillVisibilityPath(alias),
              ),
            );
            return (
              <div
                key={JSON.stringify([skill.environmentId, skill.path])}
                className="flex flex-col gap-1 px-4 py-3"
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
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Switch
                          size="sm"
                          checked={visible}
                          aria-label={`Show ${skill.name} in skill pickers`}
                          onCheckedChange={(checked) =>
                            setVisible(skill.environmentId, skill.aliases, checked)
                          }
                        />
                      }
                    />
                    <TooltipPopup side="top">
                      {visible ? "Shown in skill pickers" : "Hidden from skill pickers"}
                    </TooltipPopup>
                  </Tooltip>
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
            );
          })
        )}
      </SettingsSection>
      {adding && (
        <AddSkillDialog
          targets={targets}
          onClose={() => setAdding(false)}
          onCreated={(skill) => {
            setAdding(false);
            setRevision((value) => value + 1);
            setPreview(skill);
          }}
        />
      )}
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
