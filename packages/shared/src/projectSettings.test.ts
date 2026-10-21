import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type ProjectSettingsOverrides,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderProfileId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createModelSelection } from "./model.ts";
import {
  clearProjectSettingsOverrides,
  commonProviderProfiles,
  hasProjectSettingsOverrides,
  resolveNewThreadEnvMode,
  resolveProjectSettings,
  resolveProviderProfile,
  resolveProviderProfileFallbackModelSelection,
  resolveSendEnvMode,
  resolveWorktreeCleanup,
} from "./projectSettings.ts";
import { applyServerSettingsPatch } from "./serverSettings.ts";

const projectId = ProjectId.make("project-a");
const otherProjectId = ProjectId.make("project-b");

describe("resolveSendEnvMode", () => {
  // regression: #21404 non-git projects send from the current checkout, git repos keep their mode
  it.each(["local", "worktree"] as const)(
    "uses local for non-git projects requesting %s",
    (mode) => {
      expect(resolveSendEnvMode({ requestedEnvMode: mode, isGitRepo: false })).toBe("local");
    },
  );

  it.each(["local", "worktree"] as const)("preserves %s for git repositories", (mode) => {
    expect(resolveSendEnvMode({ requestedEnvMode: mode, isGitRepo: true })).toBe(mode);
  });
});

describe("resolveProjectSettings", () => {
  it("ignores an override left undefined by a forward-compatible decode", () => {
    const resolved = resolveProjectSettings(
      {
        ...DEFAULT_SERVER_SETTINGS,
        defaultRuntimeMode: "full-access",
        projectSettingsOverrides: { [projectId]: { defaultRuntimeMode: undefined } as never },
      },
      projectId,
    );
    expect(resolved.settings.defaultRuntimeMode).toBe("full-access");
    expect(resolved.sources.defaultRuntimeMode).toBe("environment");
    expect(
      hasProjectSettingsOverrides({
        projectSettingsOverrides: { [projectId]: { defaultRuntimeMode: undefined } as never },
      }),
    ).toBe(false);
  });

  it("applies overrides per key and reports their source", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      defaultAutoPull: true,
      sidebarAutoSettleAfterDays: 3,
      projectSettingsOverrides: {
        [projectId]: { defaultAutoPull: false, sidebarAutoSettleAfterDays: null },
      },
    });
    const resolved = resolveProjectSettings(settings, projectId);
    expect(resolved.settings.defaultAutoPull).toBe(false);
    expect(resolved.settings.sidebarAutoSettleAfterDays).toBeNull();
    expect(resolved.settings.defaultThreadEnvMode).toBe(settings.defaultThreadEnvMode);
    expect(resolved.sources.defaultAutoPull).toBe("project");
    expect(resolved.sources.sidebarAutoSettleAfterDays).toBe("project");
    expect(resolved.sources.defaultThreadEnvMode).toBe("environment");
    expect(resolveProjectSettings(settings, otherProjectId).settings.defaultAutoPull).toBe(true);
  });

  it("honours the aggregate's own fields only until the server has folded them", () => {
    const aggregateModel = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.5");
    const project = {
      defaultModelSelection: aggregateModel,
      defaultThreadEnvMode: "local" as const,
    };
    const unfolded = resolveProjectSettings(
      { ...DEFAULT_SERVER_SETTINGS, projectSettingsFolded: false },
      projectId,
      project,
    );
    expect(unfolded.settings.defaultModelSelection).toEqual(aggregateModel);
    expect(unfolded.settings.defaultThreadEnvMode).toBe("local");
    expect(unfolded.sources.defaultModelSelection).toBe("project");
    const overridden = resolveProjectSettings(
      {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsFolded: false,
        projectSettingsOverrides: { [projectId]: { defaultThreadEnvMode: "worktree" } },
      },
      projectId,
      project,
    );
    expect(overridden.settings.defaultThreadEnvMode).toBe("worktree");
    const folded = resolveProjectSettings(
      { ...DEFAULT_SERVER_SETTINGS, projectSettingsFolded: true },
      projectId,
      project,
    );
    expect(folded.settings.defaultModelSelection).toBeNull();
    expect(folded.sources.defaultModelSelection).toBe("environment");
  });

  it("keeps the environment default model when the override's provider is disabled", () => {
    const disabledSelection = createModelSelection(ProviderInstanceId.make("claudeAgent"), "opus");
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providerInstances: {
        [ProviderInstanceId.make("claudeAgent")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: false,
        },
      },
      projectSettingsOverrides: { [projectId]: { defaultModelSelection: disabledSelection } },
    });
    const resolved = resolveProjectSettings(settings, projectId);
    expect(resolved.settings.defaultModelSelection).toBeNull();
    expect(resolved.sources.defaultModelSelection).toBe("environment");
  });

  it("moves text generation off an instance the project turned off", () => {
    const codex = ProviderInstanceId.make("codex");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(codex, "gpt-5"),
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [codex]: { enabled: false } } },
      },
    };
    expect(
      resolveProjectSettings(settings, projectId).settings.textGenerationModelSelection.instanceId,
    ).toBe(ProviderInstanceId.make("claudeAgent"));
    expect(
      resolveProjectSettings(settings, otherProjectId).settings.textGenerationModelSelection,
    ).toEqual(settings.textGenerationModelSelection);
  });

  it("falls back to a configured instance when every built-in one is off for the project", () => {
    const codex = ProviderInstanceId.make("codex");
    const codexWork = ProviderInstanceId.make("codex_work");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(codex, "gpt-5"),
      providerInstances: { [codexWork]: { driver: ProviderDriverKind.make("codex"), config: {} } },
      projectSettingsOverrides: {
        [projectId]: {
          providerInstances: {
            [codex]: { enabled: false },
            [ProviderInstanceId.make("claudeAgent")]: { enabled: false },
          },
        },
      },
    };
    expect(
      resolveProjectSettings(settings, projectId).settings.textGenerationModelSelection.instanceId,
    ).toBe(codexWork);
  });
});

describe("resolveProjectSettings with a t3.json", () => {
  it("walks project override, environment value, file, then built-in for file-backed keys", () => {
    const file = { defaultThreadEnvMode: "worktree" as const };
    const fromOverride = resolveProjectSettings(
      {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsOverrides: { [projectId]: { defaultThreadEnvMode: "local" } },
      },
      projectId,
      null,
      file,
    );
    expect(fromOverride.settings.defaultThreadEnvMode).toBe("local");
    expect(fromOverride.sources.defaultThreadEnvMode).toBe("project");

    const fromEnvironment = resolveProjectSettings(
      { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "local" },
      projectId,
      null,
      file,
    );
    expect(fromEnvironment.settings.defaultThreadEnvMode).toBe("local");
    expect(fromEnvironment.sources.defaultThreadEnvMode).toBe("environment");

    const fromFile = resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId, null, file);
    expect(fromFile.settings.defaultThreadEnvMode).toBe("worktree");
    expect(fromFile.sources.defaultThreadEnvMode).toBe("t3.json");

    const builtIn = resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId, null, null);
    expect(builtIn.settings.defaultThreadEnvMode).toBe("local");
    expect(builtIn.sources.defaultThreadEnvMode).toBe("environment");
    const nullOverride = resolveProjectSettings(
      {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsOverrides: { [projectId]: { defaultThreadEnvMode: null } as never },
      },
      projectId,
      null,
      file,
    );
    expect(nullOverride.settings.defaultThreadEnvMode).toBe("worktree");
    expect(nullOverride.sources.defaultThreadEnvMode).toBe("t3.json");
    expect(
      resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId, null, {}).sources
        .defaultThreadEnvMode,
    ).toBe("environment");
  });
});

describe("resolveNewThreadEnvMode", () => {
  const worktreeEnvironment = resolveProjectSettings(
    { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "worktree" },
    projectId,
    null,
    null,
  );
  const newProject = {
    projectSettings: worktreeEnvironment,
    workspaceRoot: "/data/projects/pinball-stats",
    newProjectsRoot: "/data/projects/",
    projectHasThreads: false,
  };

  it("starts a new project's first thread in its checkout", () => {
    expect(resolveNewThreadEnvMode(newProject)).toBe("local");
    expect(
      resolveNewThreadEnvMode({
        ...newProject,
        workspaceRoot: "C:\\Data\\Projects\\Pinball-Stats",
        newProjectsRoot: "c:/data/projects",
      }),
    ).toBe("local");
  });

  it("keeps the configured default once the project has a thread or is not a new project", () => {
    expect(resolveNewThreadEnvMode({ ...newProject, projectHasThreads: true })).toBe("worktree");
    expect(resolveNewThreadEnvMode({ ...newProject, workspaceRoot: "/data/projects" })).toBe(
      "worktree",
    );
    expect(
      resolveNewThreadEnvMode({ ...newProject, workspaceRoot: "/data/projects/a/nested" }),
    ).toBe("worktree");
    expect(resolveNewThreadEnvMode({ ...newProject, workspaceRoot: "/data/projects-old/a" })).toBe(
      "worktree",
    );
    expect(resolveNewThreadEnvMode({ ...newProject, newProjectsRoot: undefined })).toBe("worktree");
  });

  it("lets a project override, or a t3.json the environment defers to, keep worktree mode", () => {
    for (const projectSettings of [
      resolveProjectSettings(
        {
          ...DEFAULT_SERVER_SETTINGS,
          projectSettingsOverrides: { [projectId]: { defaultThreadEnvMode: "worktree" } },
        },
        projectId,
        null,
        null,
      ),
      resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId, null, {
        defaultThreadEnvMode: "worktree",
      }),
    ]) {
      expect(resolveNewThreadEnvMode({ ...newProject, projectSettings })).toBe("worktree");
    }
  });
});

describe("projectSettingsOverrides patches", () => {
  it("replaces a project's entry, removes it with null, and drops empty entries", () => {
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: {
        [projectId]: { defaultAutoPull: true, enableAgentBrowserAccess: false },
        [otherProjectId]: { defaultAutoPull: false },
      },
    });
    expect(hasProjectSettingsOverrides(first)).toBe(true);
    const replaced = applyServerSettingsPatch(first, {
      projectSettingsOverrides: { [projectId]: { enableAgentBrowserAccess: false } },
    });
    expect(replaced.projectSettingsOverrides[projectId]).toEqual({
      enableAgentBrowserAccess: false,
    });
    expect(replaced.projectSettingsOverrides[otherProjectId]).toEqual({ defaultAutoPull: false });
    const emptied = applyServerSettingsPatch(replaced, {
      projectSettingsOverrides: { [projectId]: {} },
    });
    expect(emptied.projectSettingsOverrides[projectId]).toBeUndefined();
    const removed = applyServerSettingsPatch(replaced, {
      projectSettingsOverrides: { [projectId]: null },
    });
    expect(removed.projectSettingsOverrides).toEqual({
      [otherProjectId]: { defaultAutoPull: false },
    });
    expect(hasProjectSettingsOverrides(DEFAULT_SERVER_SETTINGS)).toBe(false);
  });

  it("derives the legacy per-key maps from the generic record", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: {
        [projectId]: { defaultAutoPull: true, enableAgentBrowserAccess: false },
        [otherProjectId]: { defaultProjectScripts: [] },
      },
    });
    expect(settings.projectAutoPullOverrides).toEqual({ [projectId]: true });
    expect(settings.projectAgentBrowserAccessOverrides).toEqual({ [projectId]: false });
    expect(settings.projectScriptOverrides).toEqual({ [otherProjectId]: [] });
  });

  it("translates legacy per-key patches into the generic record", () => {
    const written = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectAutoPullOverrides: { [projectId]: true },
      projectAgentBrowserAccessOverrides: { [projectId]: false, [otherProjectId]: true },
    });
    expect(written.projectSettingsOverrides).toEqual({
      [projectId]: { defaultAutoPull: true, enableAgentBrowserAccess: false },
      [otherProjectId]: { enableAgentBrowserAccess: true },
    });
    const cleared = applyServerSettingsPatch(written, {
      projectAgentBrowserAccessOverrides: { [projectId]: null, [otherProjectId]: null },
    });
    expect(cleared.projectSettingsOverrides).toEqual({ [projectId]: { defaultAutoPull: true } });
  });

  it("lets a canonical entry win over a legacy map for the same project", () => {
    const current = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } },
    });
    const next = applyServerSettingsPatch(current, {
      projectSettingsOverrides: { [projectId]: { defaultThreadEnvMode: "local" } },
      projectAutoPullOverrides: { [projectId]: true, [otherProjectId]: false },
    });
    expect(next.projectSettingsOverrides).toEqual({
      [projectId]: { defaultThreadEnvMode: "local" },
      [otherProjectId]: { defaultAutoPull: false },
    });
  });
});

describe("resolveWorktreeCleanup", () => {
  it("inherits machine rules, disables one project and keeps custom rules isolated", () => {
    const machine = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      storageCleanup: {
        worktreeAfterDays: 8,
        worktreeSettledAfterDays: 2,
        worktreeKeepWhen: "any-local-files",
        worktreeOnDelete: true,
        logsAfterDays: 3,
      },
    });
    const inherited = resolveWorktreeCleanup(machine, projectId);
    expect(inherited).toMatchObject({
      worktreeSettledAfterDays: 2,
      worktreeKeepWhen: "any-local-files",
    });
    const off = applyServerSettingsPatch(machine, {
      projectSettingsOverrides: {
        [projectId]: { worktreeCleanup: { mode: "off" } },
      },
    });
    expect(resolveWorktreeCleanup(off, projectId)).toEqual({
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnDelete: false,
      worktreeOnMerge: false,
      worktreeUnchanged: false,
      worktreeKeepWhen: "any-local-files",
    });
    expect(resolveWorktreeCleanup(off, otherProjectId)).toEqual(inherited);
    const custom = applyServerSettingsPatch(off, {
      projectSettingsOverrides: {
        [projectId]: {
          worktreeCleanup: {
            mode: "custom",
            rules: { ...inherited, worktreeAfterDays: 15, worktreeSettledAfterDays: 0 },
          },
        },
      },
    });
    expect(resolveWorktreeCleanup(custom, projectId).worktreeAfterDays).toBe(15);
    expect(resolveWorktreeCleanup(custom, projectId).worktreeSettledAfterDays).toBe(0);
    expect(resolveWorktreeCleanup(custom, otherProjectId)).toEqual(inherited);
    expect(custom.storageCleanup.logsAfterDays).toBe(3);
    const reset = applyServerSettingsPatch(custom, {
      projectSettingsOverrides: {
        [projectId]: clearProjectSettingsOverrides(custom, projectId, ["worktreeCleanup"]),
      },
    });
    expect(resolveWorktreeCleanup(reset, projectId)).toEqual(inherited);
  });
  it("completes partial machine custom rules and preserves them across edits", () => {
    const initial = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      storageCleanup: { worktreeAfterDays: 8, worktreeSettledAfterDays: 0, worktreeOnDelete: true },
    });
    const custom = applyServerSettingsPatch(initial, {
      worktreeCleanup: { mode: "custom", rules: { worktreeOnMerge: true } },
    });
    const edited = applyServerSettingsPatch(custom, {
      worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 15 } },
    });
    expect(resolveWorktreeCleanup(edited, null)).toEqual({
      worktreeAfterDays: 15,
      worktreeSettledAfterDays: 0,
      worktreeOnDelete: true,
      worktreeOnMerge: true,
      worktreeUnchanged: false,
      worktreeKeepWhen: "uncommitted-changes",
    });
    expect(
      resolveWorktreeCleanup(applyServerSettingsPatch(edited, { worktreeCleanup: null }), null)
        .worktreeAfterDays,
    ).toBe(8);
  });
});

describe("provider profiles", () => {
  const ccA = ProviderInstanceId.make("cc-a");
  const codexA = ProviderInstanceId.make("codex-a");
  const ccB = ProviderInstanceId.make("cc-b");
  const acme = ProviderProfileId.make("acme");
  const base: ServerSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      [ccA]: { driver: ProviderDriverKind.make("claudeAgent") },
      [codexA]: { driver: ProviderDriverKind.make("codex") },
      [ccB]: { driver: ProviderDriverKind.make("claudeAgent") },
    },
    defaultModelSelection: createModelSelection(ccB, "sonnet"),
    providerProfiles: {
      [acme]: {
        name: "Acme",
        instanceIds: [ccA, codexA],
        defaultModelSelection: createModelSelection(ccA, "opus"),
      },
    },
  };
  const withProjectProfile = (overrides: ProjectSettingsOverrides): ServerSettings => ({
    ...base,
    projectSettingsOverrides: { [projectId]: overrides },
  });

  it("starts new threads on the project profile's default model", () => {
    const resolved = resolveProjectSettings(
      withProjectProfile({ providerProfileId: acme }),
      projectId,
    );
    expect(resolved.settings.defaultModelSelection).toEqual(createModelSelection(ccA, "opus"));
    expect(resolveProviderProfile(resolved.settings)?.instanceIdSet.has(codexA)).toBe(true);
    expect(
      resolveProjectSettings(withProjectProfile({ providerProfileId: acme }), otherProjectId)
        .settings.defaultModelSelection,
    ).toEqual(createModelSelection(ccB, "sonnet"));
  });

  it("drops an inherited default outside the profile when the profile has none", () => {
    const settings = {
      ...withProjectProfile({ providerProfileId: acme }),
      providerProfiles: {
        [acme]: { name: "Acme", instanceIds: [ccA], defaultModelSelection: null },
      },
    };
    expect(resolveProjectSettings(settings, projectId).settings.defaultModelSelection).toBeNull();
  });

  it("keeps a project's explicit model even outside its profile", () => {
    const explicit = createModelSelection(ccB, "haiku");
    const resolved = resolveProjectSettings(
      withProjectProfile({ providerProfileId: acme, defaultModelSelection: explicit }),
      projectId,
    );
    expect(resolved.settings.defaultModelSelection).toEqual(explicit);
  });

  it("applies the environment profile and lets a project opt out with null", () => {
    const settings = { ...base, providerProfileId: acme };
    expect(resolveProjectSettings(settings, projectId).settings.defaultModelSelection).toEqual(
      createModelSelection(ccA, "opus"),
    );
    const optedOut = resolveProjectSettings(
      { ...settings, projectSettingsOverrides: { [projectId]: { providerProfileId: null } } },
      projectId,
    );
    expect(resolveProviderProfile(optedOut.settings)).toBeNull();
    expect(optedOut.settings.defaultModelSelection).toEqual(createModelSelection(ccB, "sonnet"));
  });

  it("treats a deleted profile as no profile", () => {
    const settings = withProjectProfile({ providerProfileId: ProviderProfileId.make("gone") });
    const resolved = resolveProjectSettings(settings, projectId);
    expect(resolveProviderProfile(resolved.settings)).toBeNull();
    expect(resolved.settings.defaultModelSelection).toEqual(createModelSelection(ccB, "sonnet"));
  });

  it("falls back to a ready profile instance, never one outside the profile", () => {
    const provider = (
      instanceId: ProviderInstanceId,
      status: ServerProvider["status"],
      enabled = true,
    ) =>
      ({
        instanceId,
        enabled,
        status,
        models: [
          { slug: "custom", isCustom: true },
          { slug: "haiku", isCustom: false },
          { slug: "opus", isCustom: false, isDefault: true },
        ],
      }) as unknown as ServerProvider;
    const profile = { instanceIds: [ccA, codexA] };

    expect(
      resolveProviderProfileFallbackModelSelection(profile, [
        provider(ccB, "ready"),
        provider(ccA, "warning"),
        provider(codexA, "ready"),
      ]),
    ).toEqual(createModelSelection(codexA, "opus"));
    expect(
      resolveProviderProfileFallbackModelSelection(profile, [
        provider(ccB, "ready"),
        provider(ccA, "error"),
        provider(codexA, "ready", false),
      ]),
    ).toBeNull();
  });

  it("only offers profiles every selected environment defines", () => {
    const globex = ProviderProfileId.make("globex");
    const onlyAcme = { providerProfiles: base.providerProfiles };
    const both = {
      providerProfiles: {
        ...base.providerProfiles,
        [globex]: { name: "Globex", instanceIds: [ccB], defaultModelSelection: null },
      },
    };
    expect(commonProviderProfiles([both, onlyAcme]).map(([id]) => id)).toEqual([acme]);
    expect(commonProviderProfiles([both]).map(([id]) => id)).toEqual([acme, globex]);
    expect(commonProviderProfiles([both, { providerProfiles: {} }])).toEqual([]);
  });

  it("upserts and removes profiles per entry", () => {
    const globex = ProviderProfileId.make("globex");
    const added = applyServerSettingsPatch(base, {
      providerProfiles: {
        [globex]: { name: "Globex", instanceIds: [ccB], defaultModelSelection: null },
      },
    });
    expect(Object.keys(added.providerProfiles)).toEqual([acme, globex]);
    const removed = applyServerSettingsPatch(added, { providerProfiles: { [acme]: null } });
    expect(Object.keys(removed.providerProfiles)).toEqual([globex]);
    expect(applyServerSettingsPatch(removed, { providerProfileId: globex }).providerProfileId).toBe(
      globex,
    );
  });
});
