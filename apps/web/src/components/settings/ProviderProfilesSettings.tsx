import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderProfile,
  type ProviderProfileId,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { PipetteIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button, InlineButton } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { PROVIDER_PROFILE_COLORS } from "./ProviderProfilesSettings.logic";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ProviderCustomColorPanel } from "./ProviderAccentColorPicker";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "./settingsLayout";

/** Provider instance entries for an environment, in settings order. */
export function useProviderInstanceEntries(
  providers: ReadonlyArray<ServerProvider>,
  settings: Pick<UnifiedSettings, "providerInstances" | "providers">,
): ReadonlyArray<ProviderInstanceEntry> {
  return useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
}

/** A profile's member instances as icon and name; ids of removed instances are skipped. */
export function ProviderProfileInstances({
  instanceIds,
  entries,
}: {
  instanceIds: ReadonlyArray<ProviderInstanceId>;
  entries: ReadonlyArray<ProviderInstanceEntry>;
}) {
  const members = entries.filter((entry) => instanceIds.includes(entry.instanceId));
  if (members.length === 0) return <span>No providers</span>;
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {members.map((entry) => (
        <span key={entry.instanceId} className="inline-flex items-center gap-1.5">
          <ProviderInstanceIcon
            driverKind={entry.driverKind}
            displayName={entry.displayName}
            accentColor={entry.accentColor}
            showBadge={Boolean(entry.accentColor)}
            className="size-4"
            iconClassName="size-3.5"
            badgeClassName="h-2.5 min-w-2.5 px-px text-5xs"
          />
          {entry.displayName}
        </span>
      ))}
    </span>
  );
}

export function describeProfileModel(
  selection: ModelSelection | null,
  entries: ReadonlyArray<ProviderInstanceEntry>,
): string {
  if (selection === null) return "Automatic";
  const entry = entries.find((candidate) => candidate.instanceId === selection.instanceId);
  if (!entry) return selection.model;
  const model = entry.models.find((candidate) => candidate.slug === selection.model);
  return `${entry.displayName} · ${model?.name ?? selection.model}`;
}

export interface AssignableProject {
  readonly project: EnvironmentProject;
  readonly currentProfileName: string | null;
}

export interface NewProfileExtras {
  readonly projectIds: ReadonlyArray<ProjectId>;
  readonly makeDefault: boolean;
}

export interface EditingProfile {
  readonly id: ProviderProfileId | null;
  readonly profile: ProviderProfile;
}

/** The last swatch in the profile color row: shows a custom color once picked, and edits it. */
function ProviderProfileCustomColor({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (color: string) => void;
}) {
  const custom =
    value && !(PROVIDER_PROFILE_COLORS as readonly string[]).includes(value) ? value : undefined;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            role="radio"
            aria-checked={custom !== undefined}
            aria-label="Custom color"
            className={cn(
              "flex size-5 cursor-pointer items-center justify-center rounded-full ring-offset-2 ring-offset-background outline-none focus-visible:ring-2 focus-visible:ring-ring",
              custom
                ? "ring-2 ring-foreground/60"
                : "border border-dashed border-muted-foreground/60",
            )}
            style={custom ? { background: custom } : undefined}
          >
            {custom ? null : <PipetteIcon className="size-3 text-muted-foreground" aria-hidden />}
          </button>
        }
      />
      <PopoverPopup side="bottom" align="end" sideOffset={6} padding="none">
        <ProviderCustomColorPanel
          label="Profile color"
          value={custom ?? value ?? PROVIDER_PROFILE_COLORS[0]}
          onCommit={onChange}
        />
      </PopoverPopup>
    </Popover>
  );
}

export function ProviderProfileEditorDialog({
  initial,
  entries,
  settings,
  providers,
  usedBy,
  assignableProjects,
  defaultOptionChecked = false,
  onClose,
  onSave,
  onDelete,
}: {
  readonly initial: EditingProfile;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly settings: UnifiedSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly usedBy: number;
  /** Creating only: projects the new profile can start with, and what each uses today. */
  readonly assignableProjects?: ReadonlyArray<AssignableProject>;
  /**
   * Creating with `assignableProjects` also offers to make the profile the one projects without
   * their own use; this is whether that starts checked.
   */
  readonly defaultOptionChecked?: boolean;
  readonly onClose: () => void;
  readonly onSave: (profile: ProviderProfile, extras: NewProfileExtras) => void;
  readonly onDelete: (() => void) | undefined;
}) {
  const [draft, setDraft] = useState(initial.profile);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [projectIds, setProjectIds] = useState<ReadonlySet<ProjectId>>(() => new Set());
  const [makeDefault, setMakeDefault] = useState(defaultOptionChecked);
  const creating = initial.id === null;
  const save = () =>
    onSave(
      { ...draft, name },
      { projectIds: [...projectIds], makeDefault: creating && makeDefault },
    );
  const chosen = new Set(draft.instanceIds);
  const chosenEntries = entries.filter((entry) => chosen.has(entry.instanceId));
  const selection = resolveDefaultProviderModelSelection(
    providers.filter((provider) => chosen.has(provider.instanceId)),
    draft.defaultModelSelection,
  );
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId,
    selection?.model,
  );
  const name = draft.name.trim();
  // Deleting clears references to the profile, so its projects inherit the
  // environment's profile, or every provider when that was this one.
  const fallbackProfile =
    settings.providerProfileId !== null && settings.providerProfileId !== initial.id
      ? settings.providerProfiles[settings.providerProfileId]
      : undefined;
  const deleteFallback = fallbackProfile ? `the ${fallbackProfile.name} profile` : "all providers";

  const toggleInstance = (instanceId: ProviderInstanceId, checked: boolean) => {
    const instanceIds = checked
      ? [...draft.instanceIds, instanceId]
      : draft.instanceIds.filter((id) => id !== instanceId);
    setDraft({
      ...draft,
      instanceIds,
      defaultModelSelection:
        draft.defaultModelSelection && instanceIds.includes(draft.defaultModelSelection.instanceId)
          ? draft.defaultModelSelection
          : null,
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{initial.id ? `Edit ${initial.profile.name}` : "New profile"}</DialogTitle>
          <DialogDescription>
            A profile is the set of providers a project may use, usually one per company or client.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (name && draft.instanceIds.length > 0) save();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="provider-profile-name">Name</Label>
              <div className="flex items-center gap-3">
                <Input
                  id="provider-profile-name"
                  className="min-w-0 flex-1"
                  value={draft.name}
                  placeholder="e.g. Acme"
                  autoFocus
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
                <div
                  className="flex shrink-0 items-center gap-1.5"
                  role="radiogroup"
                  aria-label="Color"
                >
                  {PROVIDER_PROFILE_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      role="radio"
                      aria-checked={draft.color === color}
                      aria-label={`Color ${color}`}
                      onClick={() => setDraft({ ...draft, color })}
                      className={cn(
                        "size-5 cursor-pointer rounded-full ring-offset-2 ring-offset-background outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        draft.color === color && "ring-2 ring-foreground/60",
                      )}
                      style={{ background: color }}
                    />
                  ))}
                  <ProviderProfileCustomColor
                    value={draft.color}
                    onChange={(color) => setDraft({ ...draft, color })}
                  />
                </div>
              </div>
            </div>

            <div className="grid gap-1.5">
              <span className="text-sm font-medium">Providers</span>
              {entries.length === 0 ? (
                <span className="text-sm text-muted-foreground">No providers on this device.</span>
              ) : (
                <div className="flex flex-col rounded-lg border border-border">
                  {entries.map((entry) => (
                    <label
                      key={entry.instanceId}
                      className="flex cursor-pointer items-center gap-3 border-b border-border/60 px-3 py-2 last:border-b-0"
                    >
                      <Checkbox
                        checked={chosen.has(entry.instanceId)}
                        onCheckedChange={(checked) => toggleInstance(entry.instanceId, checked)}
                      />
                      <ProviderInstanceIcon
                        driverKind={entry.driverKind}
                        displayName={entry.displayName}
                        accentColor={entry.accentColor}
                        showBadge={Boolean(entry.accentColor)}
                        className="size-4"
                        iconClassName="size-3.5"
                        badgeClassName="h-2.5 min-w-2.5 px-px text-5xs"
                      />
                      <span className="min-w-0 flex-1 truncate text-sm">{entry.displayName}</span>
                      {String(entry.instanceId) !== String(entry.driverKind) ? (
                        <code className="truncate text-xs text-muted-foreground">
                          {entry.instanceId}
                        </code>
                      ) : null}
                      {!entry.enabled ? (
                        <span className="text-xs text-muted-foreground">Disabled</span>
                      ) : null}
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="grid gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">Default model</span>
                {draft.defaultModelSelection ? (
                  <InlineButton
                    tone="muted"
                    onClick={() => setDraft({ ...draft, defaultModelSelection: null })}
                  >
                    Use automatic
                  </InlineButton>
                ) : null}
              </div>
              {selection && chosenEntries.length > 0 ? (
                <div>
                  <ProviderModelPicker
                    activeInstanceId={selection.instanceId}
                    model={selection.model}
                    lockedProvider={null}
                    instanceEntries={chosenEntries}
                    modelOptionsByInstance={modelOptions}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    {...(draft.defaultModelSelection ? {} : { triggerLabel: "Automatic" })}
                    onInstanceModelChange={(instanceId, model) =>
                      setDraft({
                        ...draft,
                        defaultModelSelection: createModelSelection(instanceId, model),
                      })
                    }
                  />
                </div>
              ) : (
                <span className="text-sm text-muted-foreground">
                  Choose providers to pick a default model.
                </span>
              )}
              <span className="text-xs text-muted-foreground">
                New threads in the profile's projects start on this model unless a project sets its
                own.
              </span>
            </div>

            {creating && assignableProjects && assignableProjects.length > 0 ? (
              <div className="grid gap-1.5">
                <span className="text-sm font-medium">Projects</span>
                <div className="flex max-h-48 flex-col overflow-y-auto rounded-lg border border-border">
                  {assignableProjects.map(({ project, currentProfileName }) => (
                    <label
                      key={project.id}
                      className="flex cursor-pointer items-center gap-3 border-b border-border/60 px-3 py-2 last:border-b-0"
                    >
                      <Checkbox
                        checked={projectIds.has(project.id)}
                        onCheckedChange={(checked) =>
                          setProjectIds((current) => {
                            const next = new Set(current);
                            if (checked) next.add(project.id);
                            else next.delete(project.id);
                            return next;
                          })
                        }
                      />
                      <ProjectFavicon project={project} className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate text-sm">{project.title}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {currentProfileName ?? "No profile"}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ) : null}

            {creating && assignableProjects ? (
              <label className="flex cursor-pointer items-start gap-3">
                <Checkbox
                  checked={makeDefault}
                  onCheckedChange={(checked) => setMakeDefault(checked)}
                />
                <span className="grid gap-0.5">
                  <span className="text-sm">Use for projects without a profile</span>
                  <span className="text-xs text-muted-foreground">
                    New projects and any you leave unassigned get this profile.
                  </span>
                </span>
              </label>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          {onDelete ? (
            confirmingDelete ? (
              <div className="flex items-center gap-2 sm:mr-auto">
                <Button variant="destructive" onClick={onDelete}>
                  Delete profile
                </Button>
                <span className="text-xs text-muted-foreground">
                  {usedBy > 0
                    ? `${usedBy} ${usedBy === 1 ? "project switches" : "projects switch"} to ${deleteFallback}.`
                    : "No projects use it."}
                </span>
              </div>
            ) : (
              <Button
                variant="ghost-destructive"
                className="sm:mr-auto"
                onClick={() => setConfirmingDelete(true)}
              >
                Delete
              </Button>
            )
          ) : null}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!name || draft.instanceIds.length === 0} onClick={save}>
            Save profile
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
