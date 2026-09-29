import { useAtomValue } from "@effect/atom-react";
import {
  profileScopeForId,
  profileScopeProjectKey,
  resolveProjectProfileId,
} from "@t3tools/client-runtime/state/profile-scope";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  ProjectId,
  ProviderProfile,
  ProviderProfileId,
} from "@t3tools/contracts";
import { PencilIcon, PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { EnvironmentMachineIcon } from "../components/EnvironmentMachineIcon";
import { ProjectFavicon } from "../components/ProjectFavicon";
import {
  describeProfileModel,
  ProviderProfileEditorDialog,
  ProviderProfileInstances,
  useProviderInstanceEntries,
  type EditingProfile,
} from "../components/settings/ProviderProfilesSettings";
import {
  buildCreateProviderProfilePatch,
  buildDeleteProviderProfilePatch,
  buildProjectProfilePatch,
  PROVIDER_PROFILE_COLORS,
  providerProfileIdFromName,
} from "../components/settings/ProviderProfilesSettings.logic";
import type { ProviderOperateAccess } from "../components/settings/ProviderSettingsPanel.logic";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Badge } from "../components/ui/badge";
import { Button, InlineButton } from "../components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "../components/ui/menu";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../hooks/useSettings";
import { cn } from "../lib/utils";
import { useProjects } from "../state/entities";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../state/server";
import { ProfileAvatar } from "./ProfileSwitcher";
import { useProfileEnvironments, useProfileScopeState } from "./useProfileScope";

interface ProjectProfileEntry {
  readonly project: EnvironmentProject;
  readonly profileId: ProviderProfileId | null;
  /** True when the project follows the environment default rather than choosing a profile. */
  readonly inherited: boolean;
}

function profileOption(id: ProviderProfileId, profile: ProviderProfile) {
  return {
    scope: profileScopeForId(id),
    label: profile.name,
    profile: { id, ...profile, color: profile.color ?? null },
  };
}

/** One environment's profiles as cards, with the editor dialog. */
export function EnvironmentProfiles({
  environmentId,
  access,
}: {
  environmentId: EnvironmentId;
  access: ProviderOperateAccess;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const entries = useProviderInstanceEntries(providers, settings);
  const allProjects = useProjects();
  const scopeState = useProfileScopeState();
  const knownEnvironments = useProfileEnvironments();
  const [editing, setEditing] = useState<EditingProfile | null>(null);
  const readOnly = access !== "granted";

  const profiles = Object.entries(settings.providerProfiles) as [
    ProviderProfileId,
    ProviderProfile,
  ][];
  const defaultProfileId =
    settings.providerProfileId !== null && settings.providerProfiles[settings.providerProfileId]
      ? settings.providerProfileId
      : null;
  const projects = useMemo<ReadonlyArray<ProjectProfileEntry>>(
    () =>
      allProjects
        .filter((project) => project.environmentId === environmentId)
        .map((project) => ({
          project,
          profileId: resolveProjectProfileId(settings, project.id),
          inherited: !Object.hasOwn(
            settings.projectSettingsOverrides[project.id] ?? {},
            "providerProfileId",
          ),
        }))
        .toSorted((left, right) => left.project.title.localeCompare(right.project.title)),
    [allProjects, environmentId, settings],
  );
  const unassigned = projects.filter((entry) => entry.profileId === null);
  const assign = (projectId: ProjectId, target: ProviderProfileId | null) =>
    updateSettings(buildProjectProfilePatch(settings, projectId, target));

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
  const newProfileButton = readOnly ? null : (
    <Button size="xs" variant="outline" onClick={startNew}>
      <PlusIcon aria-hidden />
      New profile
    </Button>
  );

  return (
    <>
      {profiles.length === 0 ? (
        <SettingsSection title="Profiles" headerAction={newProfileButton}>
          <SettingsRow
            title="No profiles yet"
            description="Create one profile per company or client. Its projects only offer its providers, start on its model, and get their own place in the sidebar."
          />
        </SettingsSection>
      ) : (
        profiles.map(([id, profile]) => {
          const members = projects.filter((entry) => entry.profileId === id);
          const candidates = projects.filter((entry) => entry.profileId !== id);
          const isDefault = id === defaultProfileId;
          return (
            <SettingsSection
              key={id}
              title={profile.name}
              icon={<ProfileAvatar option={profileOption(id, profile)} size="sm" />}
              headerAction={
                <span className="flex items-center gap-2">
                  {isDefault ? (
                    <Badge variant="secondary" size="sm">
                      Default
                    </Badge>
                  ) : null}
                  {readOnly ? null : isDefault ? (
                    <InlineButton
                      tone="muted"
                      onClick={() => updateSettings({ providerProfileId: null })}
                    >
                      Unset default
                    </InlineButton>
                  ) : (
                    <InlineButton
                      tone="muted"
                      onClick={() => updateSettings({ providerProfileId: id })}
                    >
                      Make default
                    </InlineButton>
                  )}
                  {readOnly ? null : (
                    <Button size="xs" variant="outline" onClick={() => setEditing({ id, profile })}>
                      <PencilIcon aria-hidden />
                      Edit
                    </Button>
                  )}
                </span>
              }
            >
              <SettingsRow
                title="Providers"
                description="Offered in the model picker for this profile's projects."
                control={
                  <ProviderProfileInstances instanceIds={profile.instanceIds} entries={entries} />
                }
              />
              <SettingsRow
                title="Default model"
                description="New threads start here unless a project picks its own."
                control={
                  <span className="text-sm">
                    {describeProfileModel(profile.defaultModelSelection, entries)}
                  </span>
                }
              />
              {knownEnvironments.length > 1 ? (
                <SettingsRow
                  title="Environments"
                  description="Its projects on each of these share one place in the sidebar."
                >
                  <ul className="mt-2 flex flex-col">
                    {knownEnvironments.map((environment) => {
                      const hasProfile = (
                        scopeState.profiles.find((candidate) => candidate.id === id)
                          ?.environmentIds ?? []
                      ).includes(environment.environmentId);
                      const projectCount = allProjects.filter(
                        (project) =>
                          project.environmentId === environment.environmentId &&
                          scopeState.projectProfiles.get(
                            profileScopeProjectKey(project.environmentId, project.id),
                          ) === id,
                      ).length;
                      return (
                        <li
                          key={environment.environmentId}
                          className={cn(
                            "flex items-center gap-2 border-t border-border/60 py-1.5 first:border-t-0",
                            !hasProfile && "text-muted-foreground",
                          )}
                        >
                          <EnvironmentMachineIcon
                            aria-hidden
                            kind={environment.machine}
                            className="size-4 shrink-0 text-muted-foreground"
                          />
                          <span className="min-w-0 flex-1 truncate text-sm">
                            {environment.label}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {hasProfile
                              ? `${projectCount} ${projectCount === 1 ? "project" : "projects"}`
                              : "Not set up"}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </SettingsRow>
              ) : null}
              <SettingsRow
                title="Projects"
                description={
                  isDefault
                    ? "Projects without their own profile use this one."
                    : members.length === 0
                      ? "No projects use this profile yet."
                      : `${members.length} ${members.length === 1 ? "project" : "projects"}`
                }
                control={
                  readOnly ? null : (
                    <AddProjectMenu
                      candidates={candidates}
                      profileNames={settings.providerProfiles}
                      onPick={(projectId) => assign(projectId, id)}
                    />
                  )
                }
              >
                {members.length > 0 ? (
                  <ul className="mt-2 flex flex-col">
                    {members.map(({ project, inherited }) => (
                      <li
                        key={project.id}
                        className="flex items-center gap-2 border-t border-border/60 py-1.5 first:border-t-0"
                      >
                        <ProjectFavicon project={project} className="size-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate text-sm">{project.title}</span>
                        {inherited ? (
                          <span className="text-xs text-muted-foreground">By default</span>
                        ) : null}
                        {readOnly ? null : (
                          <InlineButton tone="muted" onClick={() => assign(project.id, null)}>
                            Remove
                          </InlineButton>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </SettingsRow>
            </SettingsSection>
          );
        })
      )}

      {profiles.length > 0 && newProfileButton ? <div>{newProfileButton}</div> : null}

      {profiles.length > 0 && unassigned.length > 0 ? (
        <SettingsSection title="Without a profile">
          {unassigned.map(({ project }) => (
            <SettingsRow
              key={project.id}
              title={
                <span className="flex min-w-0 items-center gap-2">
                  <ProjectFavicon project={project} className="size-4 shrink-0" />
                  <span className="truncate">{project.title}</span>
                </span>
              }
              description="Offers every provider."
              control={
                readOnly ? null : (
                  <Menu>
                    <MenuTrigger render={<Button size="xs" variant="outline" />}>
                      Assign…
                    </MenuTrigger>
                    <MenuPopup align="end">
                      {profiles.map(([id, profile]) => (
                        <MenuItem key={id} onClick={() => assign(project.id, id)}>
                          <ProfileAvatar option={profileOption(id, profile)} size="sm" />
                          {profile.name}
                        </MenuItem>
                      ))}
                    </MenuPopup>
                  </Menu>
                )
              }
            />
          ))}
        </SettingsSection>
      ) : null}

      {editing && !readOnly ? (
        <ProviderProfileEditorDialog
          initial={editing}
          entries={entries}
          settings={settings}
          providers={providers}
          usedBy={
            editing.id ? projects.filter((entry) => entry.profileId === editing.id).length : 0
          }
          assignableProjects={projects.map(({ project, profileId }) => ({
            project,
            currentProfileName: profileId
              ? (settings.providerProfiles[profileId]?.name ?? null)
              : null,
          }))}
          // A first profile is usually "the company I work for": make it the fallback so every
          // project lands somewhere, not in an Unassigned bucket.
          defaultOptionChecked={profiles.length === 0 && defaultProfileId === null}
          onClose={() => setEditing(null)}
          onSave={(profile, extras) => {
            if (editing.id) {
              updateSettings({ providerProfiles: { [editing.id]: profile } });
            } else {
              const id = providerProfileIdFromName(profile.name, settings.providerProfiles);
              updateSettings(buildCreateProviderProfilePatch(settings, { id, profile, ...extras }));
            }
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

/** Projects of this environment outside the profile; picking one moves it here. */
function AddProjectMenu({
  candidates,
  profileNames,
  onPick,
}: {
  candidates: ReadonlyArray<ProjectProfileEntry>;
  profileNames: Readonly<Record<string, ProviderProfile>>;
  onPick: (projectId: ProjectId) => void;
}) {
  if (candidates.length === 0) return null;
  return (
    <Menu>
      <MenuTrigger render={<Button size="xs" variant="outline" />}>
        <PlusIcon aria-hidden />
        Add project
      </MenuTrigger>
      <MenuPopup align="end" className="w-64">
        <MenuGroup>
          <MenuGroupLabel>Move a project into this profile</MenuGroupLabel>
          {candidates.map(({ project, profileId }) => (
            <MenuItem key={project.id} onClick={() => onPick(project.id)}>
              <ProjectFavicon project={project} className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{project.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {profileId ? (profileNames[profileId]?.name ?? "") : "No profile"}
              </span>
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
