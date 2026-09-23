import {
  type AutomationConfig,
  type AutomationConversation,
  type AutomationCronTrigger,
  type AutomationGitHubEvent,
  type AutomationScheduleCadence,
  type AutomationTrigger,
  type AutomationWorkingCopy,
  DEFAULT_AUTOMATION_CATCH_UP_MINUTES,
  DEFAULT_RUNTIME_MODE,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
  isValidAutomationCronExpression,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AUTOMATION_GITHUB_EVENT_LABELS,
  AUTOMATION_WEEKDAY_NAMES,
  type AutomationTimedTrigger,
  describeCronExpression,
  describeTrigger,
  nextTriggerAt,
  scheduleTriggerToCron,
} from "@t3tools/shared/automationSchedule";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  ClockIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { isElectron } from "../../env";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import {
  createAutomation,
  deleteAutomation,
  type EnvironmentAutomation,
  runAutomationNow,
  updateAutomation,
  useAutomations,
} from "../../state/automations";
import { useProjects } from "../../state/entities";
import { useEnvironment, useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { TraitsPicker } from "../chat/TraitsPicker";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { GitHubIcon } from "../Icons";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { toastManager } from "../ui/toast";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  AUTOMATION_TEMPLATE_CATEGORIES,
  AUTOMATION_TEMPLATES,
  type AutomationTemplateCategory,
} from "./automationTemplates";

/** An automation's identity across environments, as carried in the route. */
export function automationKey(automation: Pick<EnvironmentAutomation, "environmentId" | "id">) {
  return `${automation.environmentId}:${automation.id}`;
}

interface AutomationDraft {
  readonly name: string;
  readonly enabled: boolean;
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly triggers: readonly AutomationTrigger[];
  readonly prompt: string;
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
  readonly workingCopy: AutomationWorkingCopy;
  readonly conversation: AutomationConversation;
  readonly catchUpMinutes: number;
}

const EMPTY_DRAFT: AutomationDraft = {
  name: "",
  enabled: true,
  environmentId: null,
  projectId: null,
  triggers: [],
  prompt: "",
  modelSelection: null,
  runtimeMode: DEFAULT_RUNTIME_MODE,
  workingCopy: "worktree",
  conversation: "fresh",
  catchUpMinutes: DEFAULT_AUTOMATION_CATCH_UP_MINUTES,
};

function draftFromAutomation(automation: EnvironmentAutomation): AutomationDraft {
  return {
    name: automation.name,
    enabled: automation.enabled,
    environmentId: automation.environmentId,
    projectId: automation.projectId,
    triggers: automation.triggers,
    prompt: automation.prompt,
    modelSelection: automation.modelSelection,
    runtimeMode: automation.runtimeMode,
    workingCopy: automation.workingCopy,
    conversation: automation.conversation,
    catchUpMinutes: automation.catchUpMinutes,
  };
}

/** The config to send, or why the draft cannot be saved yet. */
function configFromDraft(
  draft: AutomationDraft,
): { config: AutomationConfig; environmentId: EnvironmentId } | { error: string } {
  if (draft.environmentId === null || draft.projectId === null) {
    return { error: "Choose a project" };
  }
  if (draft.name.trim().length === 0) return { error: "Name the automation" };
  if (draft.prompt.trim().length === 0) return { error: "Write instructions" };
  if (
    draft.triggers.some(
      (trigger) => trigger.type === "cron" && !isValidAutomationCronExpression(trigger.expression),
    )
  ) {
    return { error: "Fix the cron expression" };
  }
  return {
    environmentId: draft.environmentId,
    config: {
      name: draft.name.trim(),
      enabled: draft.enabled,
      projectId: draft.projectId,
      triggers: draft.triggers.map((trigger) =>
        trigger.type === "cron" ? { ...trigger, expression: trigger.expression.trim() } : trigger,
      ),
      prompt: draft.prompt.trim(),
      modelSelection: draft.modelSelection,
      runtimeMode: draft.runtimeMode,
      workingCopy: draft.workingCopy,
      conversation: draft.conversation,
      catchUpMinutes: draft.catchUpMinutes,
    },
  };
}

function TriggerIcon({ trigger, className }: { trigger: AutomationTrigger; className?: string }) {
  return trigger.type === "github" ? (
    <GitHubIcon className={cn("size-3.5", className)} />
  ) : (
    <ClockIcon className={cn("size-3.5", className)} />
  );
}

export function AutomationsPage({
  selectedKey,
  onSelect,
}: {
  readonly selectedKey: string | null;
  readonly onSelect: (key: string | null) => void;
}) {
  const { automations, isPending } = useAutomations();
  const { environments } = useEnvironments();
  const environmentLabels = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );
  const [filter, setFilter] = useState("");
  const [newDraft, setNewDraft] = useState<AutomationDraft | null>(null);
  const selected = selectedKey
    ? automations.find((automation) => automationKey(automation) === selectedKey)
    : undefined;
  const query = filter.trim().toLowerCase();
  const visible = query
    ? automations.filter((automation) => automation.name.toLowerCase().includes(query))
    : automations;

  const startNew = () => {
    setNewDraft(null);
    onSelect(null);
  };

  let content;
  if (selected) {
    content = (
      <AutomationEditor
        key={selectedKey}
        initial={draftFromAutomation(selected)}
        existing={selected}
        onClose={startNew}
        onCreated={onSelect}
      />
    );
  } else if (selectedKey && isPending) {
    content = null;
  } else if (newDraft) {
    content = (
      <AutomationEditor
        key="new"
        initial={newDraft}
        existing={null}
        onClose={() => setNewDraft(null)}
        onCreated={(key) => {
          setNewDraft(null);
          onSelect(key);
        }}
      />
    );
  } else {
    content = (
      <AutomationGallery
        onPick={(draft) => {
          onSelect(null);
          setNewDraft(draft);
        }}
      />
    );
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="border-b">
          <WorkspaceBreadcrumb ariaLabel="Automations breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem current>
              <h1 className="flex items-center gap-2">
                <ZapIcon className="size-4 text-muted-foreground" />
                Automations
              </h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-72 shrink-0 flex-col border-r max-md:hidden">
            <div className="flex items-center gap-1 border-b p-2">
              <InputGroup className="min-w-0 flex-1">
                <InputGroupAddon>
                  <SearchIcon />
                </InputGroupAddon>
                <InputGroupInput
                  size="sm"
                  placeholder="Filter automations"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  aria-label="Filter automations"
                />
              </InputGroup>
              <Button size="icon-sm" variant="ghost" aria-label="New automation" onClick={startNew}>
                <PlusIcon />
              </Button>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col gap-0.5 p-2">
                {visible.length === 0 ? (
                  <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                    {isPending
                      ? "Loading…"
                      : automations.length === 0
                        ? "No automations yet"
                        : "No matches"}
                  </p>
                ) : (
                  visible.map((automation) => (
                    <AutomationListItem
                      key={automationKey(automation)}
                      automation={automation}
                      active={automationKey(automation) === selectedKey}
                      environmentLabel={
                        environmentLabels.size > 1
                          ? (environmentLabels.get(automation.environmentId) ?? null)
                          : null
                      }
                      onSelect={() => {
                        setNewDraft(null);
                        onSelect(automationKey(automation));
                      }}
                    />
                  ))
                )}
              </div>
            </ScrollArea>
          </aside>
          <ScrollArea className="min-h-0 min-w-0 flex-1">
            <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-8">{content}</div>
          </ScrollArea>
        </div>
      </div>
    </SidebarInset>
  );
}

function AutomationListItem({
  automation,
  active,
  environmentLabel,
  onSelect,
}: {
  automation: EnvironmentAutomation;
  active: boolean;
  /** Shown only when automations span more than one environment. */
  environmentLabel: string | null;
  onSelect: () => void;
}) {
  const [trigger] = automation.triggers;
  const lastRun = automation.runs[0];
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left text-sm hover:bg-accent/60",
        active && "bg-accent",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            automation.enabled ? "bg-emerald-500" : "bg-muted-foreground/40",
          )}
        />
        <span className="min-w-0 truncate font-medium">{automation.name}</span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5 pl-3.5 text-xs text-muted-foreground">
        {trigger ? <TriggerIcon trigger={trigger} className="size-3" /> : null}
        <span className="min-w-0 truncate">
          {trigger ? describeTrigger(trigger) : "Manual only"}
          {automation.triggers.length > 1 ? ` +${automation.triggers.length - 1}` : ""}
          {environmentLabel ? ` · ${environmentLabel}` : ""}
          {lastRun?.error ? " · last run failed" : ""}
        </span>
      </span>
    </button>
  );
}

function AutomationGallery({ onPick }: { onPick: (draft: AutomationDraft) => void }) {
  const [category, setCategory] = useState<AutomationTemplateCategory>("Popular");
  const templates = AUTOMATION_TEMPLATES.filter((template) =>
    template.categories.includes(category),
  );
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold">New automation</h2>
        <p className="text-sm text-muted-foreground">
          Run an agent on a schedule or when something happens on GitHub. Pick an example or start
          from scratch.
        </p>
      </div>
      <ToggleGroup
        aria-label="Template category"
        variant="default"
        className="flex-wrap"
        value={[category]}
        onValueChange={(next) => {
          const value = AUTOMATION_TEMPLATE_CATEGORIES.find((entry) => entry === next[0]);
          if (value) setCategory(value);
        }}
      >
        {AUTOMATION_TEMPLATE_CATEGORIES.map((entry) => (
          <Toggle key={entry} value={entry} variant="pill">
            {entry}
          </Toggle>
        ))}
      </ToggleGroup>
      <div className="grid gap-3 md:grid-cols-2">
        <GalleryCard
          icon={<PlusIcon className="size-4" />}
          title="Start from scratch"
          description="Write your own instructions and choose a trigger."
          dashed
          onClick={() => onPick(EMPTY_DRAFT)}
        />
        {templates.map((template) => {
          const Icon = template.icon;
          return (
            <GalleryCard
              key={template.id}
              icon={<Icon className="size-4" />}
              title={template.name}
              description={template.description}
              footer={
                <>
                  <TriggerIcon trigger={template.trigger} className="size-3" />
                  {describeTrigger(template.trigger)}
                </>
              }
              onClick={() =>
                onPick({
                  ...EMPTY_DRAFT,
                  name: template.name,
                  prompt: template.prompt,
                  triggers: [template.trigger],
                })
              }
            />
          );
        })}
      </div>
    </div>
  );
}

function GalleryCard({
  icon,
  title,
  description,
  footer,
  dashed = false,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  footer?: React.ReactNode;
  dashed?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-h-36 flex-col justify-between gap-4 rounded-xl border bg-card p-4 text-left transition-colors hover:bg-accent/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
        dashed && "border-dashed bg-transparent",
      )}
    >
      <span className="flex gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {icon}
        </span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-sm font-medium">{title}</span>
          <span className="text-sm text-muted-foreground">{description}</span>
        </span>
      </span>
      {footer ? (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">{footer}</span>
      ) : null}
    </button>
  );
}

function AutomationEditor({
  initial,
  existing,
  onClose,
  onCreated,
}: {
  initial: AutomationDraft;
  existing: EnvironmentAutomation | null;
  onClose: () => void;
  onCreated: (key: string) => void;
}) {
  const navigate = useNavigate();
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const create = useAtomCommand(createAutomation);
  const update = useAtomCommand(updateAutomation);
  const remove = useAtomCommand(deleteAutomation);
  const runNow = useAtomCommand(runAutomationNow);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const connectedEnvironments = useConnectedEnvironments();
  const projects = useProjects();
  // A new draft runs on this device's server until the user picks another environment.
  const environmentId =
    draft.environmentId ??
    connectedEnvironments.find((environment) => environment.environmentId === primaryEnvironmentId)
      ?.environmentId ??
    connectedEnvironments[0]?.environmentId ??
    null;

  const patch = (next: Partial<AutomationDraft>) =>
    setDraft((current) => ({ ...current, ...next }));
  const result = configFromDraft({ ...draft, environmentId });
  const moving = existing !== null && environmentId !== existing.environmentId;
  const dirty =
    existing === null || JSON.stringify(draft) !== JSON.stringify(draftFromAutomation(existing));

  const save = async () => {
    if ("error" in result) return;
    setSaving(true);
    try {
      if (existing && moving) {
        // Each server keeps its own automations, so moving is a create there and a delete here.
        const created = await create({
          environmentId: result.environmentId,
          input: { config: result.config },
        });
        if (created._tag !== "Success") return;
        await remove({ environmentId: existing.environmentId, input: { id: existing.id } });
        toastManager.add({ type: "success", title: "Automation moved" });
        onCreated(automationKey({ environmentId: result.environmentId, id: created.value.id }));
      } else if (existing) {
        const outcome = await update({
          environmentId: result.environmentId,
          input: { id: existing.id, config: result.config },
        });
        if (outcome._tag === "Success") {
          toastManager.add({ type: "success", title: "Automation saved" });
        }
      } else {
        const outcome = await create({
          environmentId: result.environmentId,
          input: { config: result.config },
        });
        if (outcome._tag === "Success") {
          onCreated(automationKey({ environmentId: result.environmentId, id: outcome.value.id }));
        }
      }
    } finally {
      setSaving(false);
    }
  };

  const openThread = (threadId: NonNullable<EnvironmentAutomation["runs"][number]["threadId"]>) => {
    if (!existing) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(existing.environmentId, threadId)),
    });
  };

  const handleRunNow = async () => {
    if (!existing) return;
    setRunning(true);
    try {
      const outcome = await runNow({
        environmentId: existing.environmentId,
        input: { id: existing.id },
      });
      if (outcome._tag !== "Success") return;
      const run = outcome.value;
      if (run.error) {
        toastManager.add({ type: "error", title: "Run failed to start", description: run.error });
      } else if (run.threadId) {
        openThread(run.threadId);
      }
    } finally {
      setRunning(false);
    }
  };

  const handleDelete = async () => {
    if (!existing) return;
    const outcome = await remove({
      environmentId: existing.environmentId,
      input: { id: existing.id },
    });
    if (outcome._tag === "Success") onClose();
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <input
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
            placeholder="Untitled"
            aria-label="Automation name"
            className="min-w-0 flex-1 bg-transparent text-xl font-semibold outline-hidden placeholder:text-muted-foreground/60"
          />
          <div className="flex shrink-0 items-center gap-2">
            {existing ? (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Delete automation"
                  onClick={() => void handleDelete()}
                >
                  <Trash2Icon />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={running || dirty}
                  onClick={() => void handleRunNow()}
                >
                  <PlayIcon />
                  Run now
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={onClose}>
                Cancel
              </Button>
            )}
            <Button
              size="sm"
              disabled={"error" in result || saving || !dirty}
              title={"error" in result ? result.error : undefined}
              onClick={() => void save()}
            >
              {moving ? "Move" : existing ? "Save" : "Create"}
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2 text-muted-foreground">
            <Switch
              size="sm"
              checked={draft.enabled}
              onCheckedChange={(enabled) => patch({ enabled })}
            />
            Active
          </label>
          <span aria-hidden className="h-4 w-px bg-border" />
          {environmentId ? (
            <>
              <EnvironmentPicker
                environmentId={environmentId}
                onChange={(next) => {
                  if (next === environmentId) return;
                  const currentProject = projects.find(
                    (project) =>
                      project.environmentId === environmentId && project.id === draft.projectId,
                  );
                  patch({
                    environmentId: next,
                    projectId: matchProjectOn(projects, currentProject, next),
                    // Models are per environment; the new one starts on its default.
                    modelSelection: null,
                  });
                }}
              />
              <ProjectPicker
                environmentId={environmentId}
                projectId={draft.projectId}
                onChange={(projectId) => patch({ environmentId, projectId })}
              />
            </>
          ) : (
            <span className="text-muted-foreground">Connect an environment to run automations</span>
          )}
        </div>
      </div>

      <EditorSection title="Triggers">
        <div className="divide-y rounded-lg border">
          {draft.triggers.map((trigger, index) => (
            <TriggerRow
              // oxlint-disable-next-line react/no-array-index-key -- triggers have no identity of their own
              key={index}
              trigger={trigger}
              onChange={(next) =>
                patch({
                  triggers: draft.triggers.map((entry, i) => (i === index ? next : entry)),
                })
              }
              onRemove={() => patch({ triggers: draft.triggers.filter((_, i) => i !== index) })}
            />
          ))}
          <AddTriggerMenu onAdd={(trigger) => patch({ triggers: [...draft.triggers, trigger] })} />
        </div>
        {draft.triggers.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Without a trigger, the automation only runs when you press Run now.
          </p>
        ) : null}
      </EditorSection>

      <EditorSection title="Instructions">
        <Textarea
          value={draft.prompt}
          onChange={(event) => patch({ prompt: event.target.value })}
          placeholder="Tell the agent what to do when this automation runs…"
          aria-label="Instructions"
          rows={8}
        />
        <div className="flex flex-wrap items-center gap-1">
          {environmentId ? (
            <AutomationModelPicker
              environmentId={environmentId}
              value={draft.modelSelection}
              onChange={(modelSelection) => patch({ modelSelection })}
            />
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          Sent as the first message of each run. GitHub triggers append the pull request or issue.
        </p>
      </EditorSection>

      <EditorSection title="Session">
        <div className="divide-y rounded-lg border">
          <OptionRow
            title="Working copy"
            description="A fresh worktree per run, or the project checkout"
          >
            <OptionSelect
              label="Working copy"
              value={draft.workingCopy}
              options={[
                ["worktree", "Fresh worktree"],
                ["local", "Project checkout"],
              ]}
              onChange={(workingCopy) => patch({ workingCopy })}
            />
          </OptionRow>
          <OptionRow
            title="Conversation"
            description="A new thread, or continue the last run's thread"
          >
            <OptionSelect
              label="Conversation"
              value={draft.conversation}
              options={[
                ["fresh", "Start fresh"],
                ["continue", "Continue last run"],
              ]}
              onChange={(conversation) => patch({ conversation })}
            />
          </OptionRow>
          <OptionRow
            title="Permissions"
            description={runtimeModeConfig[draft.runtimeMode].description}
          >
            <OptionSelect
              label="Permissions"
              value={draft.runtimeMode}
              options={runtimeModeOptions.map(
                (mode) => [mode, runtimeModeConfig[mode].label] as const,
              )}
              onChange={(runtimeMode) => patch({ runtimeMode })}
            />
          </OptionRow>
        </div>
      </EditorSection>

      <div className="rounded-lg border">
        <Collapsible>
          <CollapsibleTrigger className="group flex w-full items-center justify-between gap-3 px-4 py-3 text-left">
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Advanced</span>
              <span className="text-xs text-muted-foreground">Catch-up window for missed runs</span>
            </span>
            <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-panel-open:rotate-180" />
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="border-t">
              <OptionRow
                title="Catch-up window"
                description="If the server was asleep at run time, still run when it wakes within this window"
              >
                <OptionSelect
                  label="Catch-up window"
                  value={String(draft.catchUpMinutes)}
                  options={[
                    ["0", "Skip missed runs"],
                    ["15", "15 minutes"],
                    ["60", "1 hour"],
                    ["360", "6 hours"],
                    ["1440", "24 hours"],
                  ]}
                  onChange={(value) => patch({ catchUpMinutes: Number(value) })}
                />
              </OptionRow>
            </div>
          </CollapsiblePanel>
        </Collapsible>
      </div>

      {existing ? <RunHistory automation={existing} onOpenThread={openThread} /> : null}
    </div>
  );
}

function EditorSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="px-1 text-sm font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function OptionRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm">{title}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function OptionSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  onChange: (value: T) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const match = options.find(([option]) => option === next);
        if (match) onChange(match[0]);
      }}
    >
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue>{options.find(([option]) => option === value)?.[1]}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {options.map(([option, optionLabel]) => (
          <SelectItem key={option} value={option}>
            {optionLabel}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

const CADENCE_LABELS: Record<AutomationScheduleCadence, string> = {
  hourly: "Hourly",
  daily: "Daily",
  weekdays: "Weekdays",
  weekly: "Weekly",
};

const MINUTE_OPTIONS = Array.from({ length: 12 }, (_, index) => {
  const minute = String(index * 5);
  return [minute, `:${minute.padStart(2, "0")}`] as const;
});

function TriggerRow({
  trigger,
  onChange,
  onRemove,
}: {
  trigger: AutomationTrigger;
  onChange: (trigger: AutomationTrigger) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
      <TriggerIcon trigger={trigger} className="size-4 text-muted-foreground" />
      {trigger.type === "github" ? (
        <span>
          {AUTOMATION_GITHUB_EVENT_LABELS[trigger.event]}
          <span className="text-muted-foreground"> on the project's GitHub repository</span>
        </span>
      ) : trigger.type === "cron" ? (
        <CronTriggerFields trigger={trigger} onChange={onChange} />
      ) : (
        <>
          <CadenceSelect
            value={trigger.cadence}
            onChange={(cadence) =>
              onChange(
                cadence === "custom"
                  ? { type: "cron", expression: scheduleTriggerToCron(trigger) }
                  : { ...trigger, cadence },
              )
            }
          />
          {trigger.cadence === "weekly" ? (
            <OptionSelect
              label="Day"
              value={String(trigger.weekday)}
              options={AUTOMATION_WEEKDAY_NAMES.map((day, index) => [String(index), day] as const)}
              onChange={(weekday) => onChange({ ...trigger, weekday: Number(weekday) })}
            />
          ) : null}
          <span className="text-muted-foreground">at</span>
          {trigger.cadence === "hourly" ? (
            <OptionSelect
              label="Minute"
              value={String(trigger.minute - (trigger.minute % 5))}
              options={MINUTE_OPTIONS}
              onChange={(minute) => onChange({ ...trigger, minute: Number(minute) })}
            />
          ) : (
            <Input
              type="time"
              size="sm"
              aria-label="Time"
              className="w-28"
              value={`${String(trigger.hour).padStart(2, "0")}:${String(trigger.minute).padStart(2, "0")}`}
              onChange={(event) => {
                const [hour, minute] = event.target.value.split(":").map(Number);
                if (hour === undefined || minute === undefined) return;
                if (Number.isNaN(hour) || Number.isNaN(minute)) return;
                onChange({ ...trigger, hour, minute });
              }}
            />
          )}
          <NextRunLabel trigger={trigger} />
        </>
      )}
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Remove trigger"
        className="ms-auto"
        onClick={onRemove}
      >
        <XIcon />
      </Button>
    </div>
  );
}

function CadenceSelect({
  value,
  onChange,
}: {
  value: AutomationScheduleCadence | "custom";
  onChange: (value: AutomationScheduleCadence | "custom") => void;
}) {
  return (
    <OptionSelect
      label="Schedule"
      value={value}
      options={[
        ...(Object.keys(CADENCE_LABELS) as AutomationScheduleCadence[]).map(
          (cadence) => [cadence, CADENCE_LABELS[cadence]] as const,
        ),
        ["custom", "Custom (cron)"] as const,
      ]}
      onChange={onChange}
    />
  );
}

function CronTriggerFields({
  trigger,
  onChange,
}: {
  trigger: AutomationCronTrigger;
  onChange: (trigger: AutomationTrigger) => void;
}) {
  const label = describeCronExpression(trigger.expression);
  return (
    <>
      <CadenceSelect
        value="custom"
        onChange={(cadence) => {
          if (cadence !== "custom") {
            onChange({ type: "schedule", cadence, hour: 9, minute: 0, weekday: 1 });
          }
        }}
      />
      <Input
        size="sm"
        aria-label="Cron expression"
        aria-invalid={label === null}
        placeholder="0 */2 * * *"
        spellCheck={false}
        className="w-40"
        value={trigger.expression}
        onChange={(event) => onChange({ ...trigger, expression: event.target.value })}
      />
      {label === null ? (
        <span className="text-xs text-destructive-foreground">
          Enter five fields: minute hour day month weekday
        </span>
      ) : (
        <>
          <span className="text-xs">{label}</span>
          <NextRunLabel trigger={trigger} />
        </>
      )}
    </>
  );
}

function NextRunLabel({ trigger }: { trigger: AutomationTimedTrigger }) {
  // Read once on mount: the label only needs to be right while the user is editing the row.
  const [now] = useState(Date.now);
  const next = nextTriggerAt(trigger, now);
  if (next === null) return null;
  return (
    <span className="text-xs text-muted-foreground">
      next{" "}
      {new Date(next).toLocaleString(undefined, {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      })}
    </span>
  );
}

const GITHUB_EVENTS: readonly AutomationGitHubEvent[] = [
  "pull_request.draft_opened",
  "pull_request.opened",
  "issue.opened",
];

function AddTriggerMenu({ onAdd }: { onAdd: (trigger: AutomationTrigger) => void }) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-muted-foreground hover:bg-accent/40 hover:text-foreground"
          />
        }
      >
        <PlusIcon className="size-4" />
        Add trigger
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-52">
        <MenuSub>
          <MenuSubTrigger>
            <ClockIcon />
            Scheduled
          </MenuSubTrigger>
          <MenuSubPopup>
            {(Object.keys(CADENCE_LABELS) as AutomationScheduleCadence[]).map((cadence) => (
              <MenuItem
                key={cadence}
                onClick={() => onAdd({ type: "schedule", cadence, hour: 9, minute: 0, weekday: 1 })}
              >
                {CADENCE_LABELS[cadence]}
              </MenuItem>
            ))}
            <MenuItem onClick={() => onAdd({ type: "cron", expression: "0 9 * * 1-5" })}>
              Custom (cron)
            </MenuItem>
          </MenuSubPopup>
        </MenuSub>
        <MenuSub>
          <MenuSubTrigger>
            <GitHubIcon />
            GitHub
          </MenuSubTrigger>
          <MenuSubPopup>
            {GITHUB_EVENTS.map((event) => (
              <MenuItem key={event} onClick={() => onAdd({ type: "github", event })}>
                {AUTOMATION_GITHUB_EVENT_LABELS[event]}
              </MenuItem>
            ))}
          </MenuSubPopup>
        </MenuSub>
      </MenuPopup>
    </Menu>
  );
}

/** Connected environments, which are the only ones that can take an automation right now. */
function useConnectedEnvironments() {
  const { environments } = useEnvironments();
  return useMemo(
    () => environments.filter((environment) => environment.connection.phase === "connected"),
    [environments],
  );
}

/** The same project on another environment: same repository, else same path, else same name. */
function matchProjectOn(
  projects: readonly EnvironmentProject[],
  from: EnvironmentProject | undefined,
  environmentId: EnvironmentId,
): ProjectId | null {
  if (!from) return null;
  const candidates = projects.filter((project) => project.environmentId === environmentId);
  const repository = from.repositoryIdentity?.canonicalKey;
  const match =
    (repository
      ? candidates.find((project) => project.repositoryIdentity?.canonicalKey === repository)
      : undefined) ??
    candidates.find((project) => project.workspaceRoot === from.workspaceRoot) ??
    candidates.find((project) => project.title === from.title);
  return match?.id ?? null;
}

function EnvironmentPicker({
  environmentId,
  onChange,
}: {
  environmentId: EnvironmentId;
  onChange: (environmentId: EnvironmentId) => void;
}) {
  const connected = useConnectedEnvironments();
  const current = useEnvironment(environmentId);
  const machine = resolveEnvironmentMachineKind(current?.serverConfig ?? null);
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="sm" variant="ghost" aria-label="Environment that runs this" />}
        className="max-w-64"
      >
        <EnvironmentMachineIcon kind={machine} className="size-4 shrink-0" />
        <span className="min-w-0 truncate">{current?.label ?? "Choose environment"}</span>
        <ChevronDownIcon className="size-3.5 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="start" className="max-h-80 overflow-y-auto">
        <MenuRadioGroup
          value={environmentId}
          onValueChange={(value) => {
            const environment = connected.find((entry) => entry.environmentId === value);
            if (environment) onChange(environment.environmentId);
          }}
        >
          {connected.map((environment) => (
            <MenuRadioItem
              key={environment.environmentId}
              value={environment.environmentId}
              closeOnClick
            >
              <span className="flex min-w-0 items-center gap-2">
                <EnvironmentMachineIcon
                  kind={resolveEnvironmentMachineKind(environment.serverConfig)}
                  className="size-4 shrink-0"
                />
                <span className="min-w-0 truncate">{environment.label}</span>
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

function ProjectPicker({
  environmentId,
  projectId,
  onChange,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  onChange: (projectId: ProjectId) => void;
}) {
  const projects = useProjects();
  const choices = useMemo(
    () =>
      projects
        .filter((project) => project.environmentId === environmentId)
        .toSorted((a, b) => a.title.localeCompare(b.title)),
    [environmentId, projects],
  );
  const current = choices.find((project) => project.id === projectId);

  return (
    <Menu>
      <MenuTrigger render={<Button size="sm" variant="ghost" />} className="max-w-72">
        {current ? <ProjectFavicon project={current} className="size-4 shrink-0" /> : null}
        <span className="min-w-0 truncate">{current?.title ?? "Choose project"}</span>
        <ChevronDownIcon className="size-3.5 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="start" className="max-h-80 overflow-y-auto">
        {choices.length === 0 ? (
          <p className="px-3 py-4 text-center text-sm text-muted-foreground">
            No projects on this environment
          </p>
        ) : (
          <MenuRadioGroup
            value={current?.id ?? ""}
            onValueChange={(value) => {
              const project = choices.find((choice) => choice.id === value);
              if (project) onChange(project.id);
            }}
          >
            {choices.map((project) => (
              <MenuRadioItem key={project.id} value={project.id} closeOnClick>
                <span className="flex min-w-0 items-center gap-2">
                  <ProjectFavicon project={project} className="size-4 shrink-0" />
                  <span className="min-w-0 truncate">{project.title}</span>
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        )}
      </MenuPopup>
    </Menu>
  );
}

function AutomationModelPicker({
  environmentId,
  value,
  onChange,
}: {
  environmentId: EnvironmentId;
  value: ModelSelection | null;
  onChange: (selection: ModelSelection) => void;
}) {
  const environment = useEnvironment(environmentId);
  const settings = useEnvironmentSettings(environmentId);
  const providers = environment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const selection = resolveDefaultProviderModelSelection(
    providers,
    value ?? settings.defaultModelSelection,
  );
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId,
    selection?.model,
  );
  const activeEntry = entries.find((entry) => entry.instanceId === selection?.instanceId);

  // Until the user picks one, `value` stays null and runs follow the project's default model.
  if (!selection || !activeEntry) {
    return <span className="px-1 text-xs text-muted-foreground">No providers available</span>;
  }
  return (
    <>
      <ProviderModelPicker
        activeInstanceId={selection.instanceId}
        model={selection.model}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={modelOptions}
        onInstanceModelChange={(instanceId, model) =>
          onChange(createModelSelection(instanceId, model))
        }
      />
      <TraitsPicker
        provider={activeEntry.driverKind}
        models={activeEntry.models}
        model={selection.model}
        prompt=""
        onPromptChange={() => {}}
        modelOptions={selection.options ?? []}
        allowPromptInjectedEffort={false}
        planModeEnabled={settings.planModeEnabled}
        onModelOptionsChange={(options) =>
          onChange(createModelSelection(selection.instanceId, selection.model, options))
        }
      />
    </>
  );
}

function RunHistory({
  automation,
  onOpenThread,
}: {
  automation: EnvironmentAutomation;
  onOpenThread: (threadId: NonNullable<EnvironmentAutomation["runs"][number]["threadId"]>) => void;
}) {
  return (
    <EditorSection title="Recent runs">
      {automation.runs.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground">No runs yet.</p>
      ) : (
        <div className="divide-y rounded-lg border">
          {automation.runs.map((run) => {
            const threadId = run.threadId;
            return (
              <div key={run.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    run.error ? "bg-destructive" : "bg-emerald-500",
                  )}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="min-w-0 truncate">{run.cause}</span>
                  {run.error ? (
                    <span className="text-xs text-destructive-foreground">{run.error}</span>
                  ) : null}
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatRelativeTimeLabel(run.startedAt)}
                </span>
                {threadId ? (
                  <Button size="xs" variant="ghost" onClick={() => onOpenThread(threadId)}>
                    Open thread
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </EditorSection>
  );
}
