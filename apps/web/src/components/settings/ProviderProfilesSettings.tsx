import {
  type EnvironmentId,
  type ModelSelection,
  type ProviderInstanceId,
  type ProviderProfile,
  type ProviderProfileId,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { PencilIcon, PipetteIcon, PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useProjects } from "../../state/entities";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { ProviderProfileChip } from "../ProviderProfileChip";
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
import {
  buildDeleteProviderProfilePatch,
  PROVIDER_PROFILE_COLORS,
  providerProfileIdFromName,
  resolveProjectProviderProfileId,
} from "./ProviderProfilesSettings.logic";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ProviderCustomColorPanel } from "./ProviderAccentColorPicker";
import { searchableSetting } from "./settingsSearch";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow, SettingsSection } from "./settingsLayout";

/** Provider instance entries for an environment, in settings order. */
function useProviderInstanceEntries(
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

function describeProfileModel(
  selection: ModelSelection | null,
  entries: ReadonlyArray<ProviderInstanceEntry>,
): string {
  if (selection === null) return "Automatic";
  const entry = entries.find((candidate) => candidate.instanceId === selection.instanceId);
  if (!entry) return selection.model;
  const model = entry.models.find((candidate) => candidate.slug === selection.model);
  return `${entry.displayName} · ${model?.name ?? selection.model}`;
}

interface EditingProfile {
  readonly id: ProviderProfileId | null;
  readonly profile: ProviderProfile;
}

/**
 * Profiles group this environment's provider instances, usually one per
 * company or client. Projects pick a profile in their settings.
 */
export function ProviderProfilesSettings({
  environmentId,
  settings,
  providers,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly settings: UnifiedSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly readOnly: boolean;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const entries = useProviderInstanceEntries(providers, settings);
  const allProjects = useProjects();
  const [editing, setEditing] = useState<EditingProfile | null>(null);
  const profiles = Object.entries(settings.providerProfiles) as [
    ProviderProfileId,
    ProviderProfile,
  ][];
  const projectsByProfile = useMemo(() => {
    const byProfile = new Map<ProviderProfileId, string[]>();
    for (const project of allProjects) {
      if (project.environmentId !== environmentId) continue;
      const id = resolveProjectProviderProfileId(settings, project.id);
      if (id !== null) byProfile.set(id, [...(byProfile.get(id) ?? []), project.title]);
    }
    return byProfile;
  }, [allProjects, environmentId, settings]);

  const startNew = () =>
    setEditing({
      id: null,
      profile: {
        name: "",
        color:
          PROVIDER_PROFILE_COLORS[profiles.length % PROVIDER_PROFILE_COLORS.length] ??
          PROVIDER_PROFILE_COLORS[0],
        instanceIds: [],
        defaultModelSelection: null,
      },
    });

  return (
    <>
      <SettingsSection
        {...searchableSetting("provider-profiles")}
        headerAction={
          readOnly ? null : (
            <Button size="xs" variant="outline" onClick={startNew}>
              <PlusIcon aria-hidden />
              New profile
            </Button>
          )
        }
      >
        {profiles.length === 0 ? (
          <SettingsRow
            title="No profiles"
            description="Group providers into a profile, such as one per client, so a project only offers those providers and starts new threads on the profile's model."
          />
        ) : (
          profiles.map(([id, profile]) => {
            const projects = projectsByProfile.get(id) ?? [];
            return (
              <SettingsRow
                key={id}
                title={
                  <span className="flex min-w-0 items-center gap-2">
                    <ProviderProfileChip name={profile.name} color={profile.color} />
                    <span className="min-w-0 truncate text-xs font-normal text-muted-foreground">
                      {projects.length === 0
                        ? "No projects"
                        : `${projects.length} ${projects.length === 1 ? "project" : "projects"}: ${projects.join(", ")}`}
                    </span>
                  </span>
                }
                description={`Default model: ${describeProfileModel(profile.defaultModelSelection, entries)}`}
                status={
                  <ProviderProfileInstances instanceIds={profile.instanceIds} entries={entries} />
                }
                control={
                  readOnly ? null : (
                    <Button size="xs" variant="outline" onClick={() => setEditing({ id, profile })}>
                      <PencilIcon aria-hidden />
                      Edit
                    </Button>
                  )
                }
              />
            );
          })
        )}
      </SettingsSection>
      {editing && !readOnly ? (
        <ProviderProfileEditorDialog
          initial={editing}
          entries={entries}
          settings={settings}
          providers={providers}
          usedBy={editing.id ? (projectsByProfile.get(editing.id)?.length ?? 0) : 0}
          onClose={() => setEditing(null)}
          onSave={(profile) => {
            const id =
              editing.id ?? providerProfileIdFromName(profile.name, settings.providerProfiles);
            updateSettings({ providerProfiles: { [id]: profile } });
            setEditing(null);
          }}
          onDelete={
            editing.id
              ? () => {
                  if (editing.id)
                    updateSettings(buildDeleteProviderProfilePatch(settings, editing.id));
                  setEditing(null);
                }
              : undefined
          }
        />
      ) : null}
    </>
  );
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

function ProviderProfileEditorDialog({
  initial,
  entries,
  settings,
  providers,
  usedBy,
  onClose,
  onSave,
  onDelete,
}: {
  readonly initial: EditingProfile;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly settings: UnifiedSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly usedBy: number;
  readonly onClose: () => void;
  readonly onSave: (profile: ProviderProfile) => void;
  readonly onDelete: (() => void) | undefined;
}) {
  const [draft, setDraft] = useState(initial.profile);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
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
              if (name && draft.instanceIds.length > 0) onSave({ ...draft, name });
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
          <Button
            disabled={!name || draft.instanceIds.length === 0}
            onClick={() => onSave({ ...draft, name })}
          >
            Save profile
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
