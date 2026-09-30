import { normalizeSkillVisibilityPath } from "@t3tools/client-runtime/providerSkills";
import {
  CopyIcon,
  FolderGit2Icon,
  FolderOpenIcon,
  PlusIcon,
  SearchIcon,
  SparklesIcon,
  TriangleAlertIcon,
  UserRoundIcon,
} from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";

import { useProjectFileQuery } from "../files/projectFilesQueryState";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { useSkillVisibility } from "../../hooks/useSkillVisibility";
import { cn } from "../../lib/utils";
import {
  AntigravityIcon,
  ClaudeAI,
  CursorIcon,
  GrokIcon,
  type Icon,
  OpenAI,
  OpenCodeIcon,
} from "../Icons";
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
import {
  groupSkills,
  skillSourceKey,
  type SkillGroup,
  type SkillSourceKey,
} from "./skillPresentation";

// Each source gets its brand mark on a tile tinted with its own color, so a long list scans by
// where a skill comes from. Shared ~/.agents skills use the product accent.
const SOURCE_PRESENTATION: Readonly<
  Record<
    SkillSourceKey,
    { readonly label: string; readonly tint: string; readonly icon: Icon | null }
  >
> = {
  agents: { label: "Shared", tint: "var(--color-primary)", icon: null },
  claude: { label: "Claude Code", tint: "#D97757", icon: ClaudeAI },
  codex: { label: "Codex", tint: "#10A37F", icon: OpenAI },
  cursor: { label: "Cursor", tint: "#8B93A7", icon: CursorIcon },
  opencode: { label: "OpenCode", tint: "#E0A030", icon: OpenCodeIcon },
  grok: { label: "Grok", tint: "#8B93A7", icon: GrokIcon },
  antigravity: { label: "Antigravity", tint: "#4285F4", icon: AntigravityIcon },
  other: { label: "Other", tint: "var(--color-muted-foreground)", icon: null },
};

function SkillSourceTile({ source }: { readonly source: string }) {
  const presentation = SOURCE_PRESENTATION[skillSourceKey(source)];
  const SourceIcon = presentation.icon ?? SparklesIcon;
  return (
    <span
      aria-hidden
      style={{
        backgroundColor: `color-mix(in srgb, ${presentation.tint} 14%, transparent)`,
        color: presentation.tint,
      }}
      className="flex size-8 shrink-0 items-center justify-center rounded-lg"
    >
      <SourceIcon className="size-4" />
    </span>
  );
}

function SkillSourceLabel({ source }: { readonly source: string }) {
  const key = skillSourceKey(source);
  const presentation = SOURCE_PRESENTATION[key];
  return (
    <Badge
      variant="label"
      size="sm"
      style={{ "--label": presentation.tint } as CSSProperties}
      className="shrink-0"
    >
      {key === "other" ? source : presentation.label}
    </Badge>
  );
}

function SkillGroupHeader({ group }: { readonly group: SkillGroup }) {
  const GroupIcon = group.kind === "personal" ? UserRoundIcon : FolderGit2Icon;
  return (
    <div className="flex items-center gap-2 bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground first:rounded-t-xl">
      <GroupIcon aria-hidden className="size-3.5" />
      <span className="font-medium text-foreground/80">{group.label}</span>
      {group.environmentLabel ? <span>· {group.environmentLabel}</span> : null}
      <span className="ms-auto tabular-nums">{group.skills.length}</span>
    </div>
  );
}

function SkillRow({
  skill,
  visible,
  canReveal,
  onPreview,
  onVisibleChange,
  onCopyPath,
  onReveal,
}: {
  readonly skill: SkillGroup["skills"][number];
  readonly visible: boolean;
  readonly canReveal: boolean;
  readonly onPreview: () => void;
  readonly onVisibleChange: (visible: boolean) => void;
  readonly onCopyPath: () => void;
  readonly onReveal: () => void;
}) {
  return (
    <div className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/40">
      <button
        type="button"
        onClick={onPreview}
        aria-label={`Preview ${skill.name}`}
        className={cn(
          "flex min-w-0 flex-1 items-start gap-3 rounded-md text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
          !visible && "opacity-55",
        )}
      >
        <SkillSourceTile source={skill.source} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{skill.name}</span>
            {visible ? null : (
              <Badge variant="outline" size="sm">
                Hidden
              </Badge>
            )}
          </span>
          {skill.description ? (
            <span className="truncate text-sm text-muted-foreground">{skill.description}</span>
          ) : null}
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground/80">
            <SkillSourceLabel source={skill.source} />
            <span aria-hidden>·</span>
            <span className="truncate font-mono">{skill.displayPath}</span>
          </span>
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-1">
        <div className="flex items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`Copy path of ${skill.name}`}
                  onClick={onCopyPath}
                >
                  <CopyIcon />
                </Button>
              }
            />
            <TooltipPopup side="top">Copy path</TooltipPopup>
          </Tooltip>
          {canReveal ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Reveal ${skill.name} in file manager`}
                    onClick={onReveal}
                  >
                    <FolderOpenIcon />
                  </Button>
                }
              />
              <TooltipPopup side="top">Reveal in file manager</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Switch
                size="sm"
                checked={visible}
                aria-label={`Show ${skill.name} in skill pickers`}
                onCheckedChange={onVisibleChange}
              />
            }
          />
          <TooltipPopup side="top">
            {visible ? "Shown in skill pickers" : "Hidden from skill pickers"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}

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
  const groups = groupSkills(filtered, targets);
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
          groups.map((group) => (
            <div
              key={group.key}
              className="flex flex-col [&>*+*]:border-t [&>*+*]:border-border/50"
            >
              <SkillGroupHeader group={group} />
              {group.skills.map((skill) => {
                const hidden = hiddenByEnvironment[skill.environmentId] ?? [];
                const visible = !skill.aliases.some((alias) =>
                  hidden.some(
                    (path) =>
                      normalizeSkillVisibilityPath(path) === normalizeSkillVisibilityPath(alias),
                  ),
                );
                return (
                  <SkillRow
                    key={JSON.stringify([skill.environmentId, skill.path])}
                    skill={skill}
                    visible={visible}
                    canReveal={revealableEnvironments.has(skill.environmentId)}
                    onPreview={() => setPreview(skill)}
                    onVisibleChange={(checked) =>
                      setVisible(skill.environmentId, skill.aliases, checked)
                    }
                    onCopyPath={() => {
                      void writeTextToClipboard(skill.path).catch(() =>
                        toastManager.add({ type: "error", title: "Could not copy skill path" }),
                      );
                    }}
                    onReveal={() => {
                      void openInEditor({
                        environmentId: skill.environmentId,
                        input: { cwd: skill.path, editor: "file-manager", reveal: true },
                      }).then((result) => {
                        if (result._tag === "Failure")
                          toastManager.add({ type: "error", title: "Could not reveal skill" });
                      });
                    }}
                  />
                );
              })}
            </div>
          ))
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
