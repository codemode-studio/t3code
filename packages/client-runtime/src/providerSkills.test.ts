import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applySkillVisibility,
  setSkillPathVisibility,
  getProviderSkillsForSlashMenu,
  hasCompleteProviderWorkspaceSnapshot,
  resolveProviderForCwd,
  resolveProviderSkillsForCwd,
  resolveProviderSlashCommandsForCwd,
} from "./providerSkills.ts";

const provider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
  slashCommands: [{ name: "global" }],
  skills: [{ name: "global", path: "/global/SKILL.md", enabled: true }],
  workspaceSnapshots: [
    {
      cwd: "/workspace/project-a",
      checkedAt: "2026-01-01T00:01:00.000Z",
      slashCommands: [{ name: "project" }],
      skills: [{ name: "project", path: "/workspace/project-a/SKILL.md", enabled: true }],
    },
  ],
} satisfies ServerProvider;

describe("getProviderSkillsForSlashMenu", () => {
  it("keeps the skill alias when the provider also exposes it as a slash command", () => {
    const askMatt = {
      name: "ask-matt",
      path: "/Users/matt/.agents/skills/ask-matt/SKILL.md",
      enabled: true,
    };
    expect(getProviderSkillsForSlashMenu([askMatt], true).map((skill) => skill.name)).toEqual([
      "ask-matt",
    ]);
  });

  it("shows one row when enabled skills share a name", () => {
    const skills = [
      {
        name: "babysit-pr",
        path: "/Users/matt/.codex/skills/babysit-pr/SKILL.md",
        enabled: true,
      },
      {
        name: "browser",
        path: "/Users/matt/.agents/skills/browser/SKILL.md",
        enabled: true,
      },
      {
        name: "babysit-pr",
        path: "/Users/matt/.agents/skills/babysit-pr/SKILL.md",
        enabled: true,
      },
    ];

    expect(getProviderSkillsForSlashMenu(skills, true).map((skill) => skill.name)).toEqual([
      "babysit-pr",
      "browser",
    ]);
  });

  it("keeps an enabled skill when a disabled duplicate appears first", () => {
    const enabledSkill = {
      name: "babysit-pr",
      path: "/Users/matt/.agents/skills/babysit-pr/SKILL.md",
      enabled: true,
    };
    const skills = [
      {
        name: "babysit-pr",
        path: "/Users/matt/.codex/skills/babysit-pr/SKILL.md",
        enabled: false,
      },
      enabledSkill,
    ];

    expect(getProviderSkillsForSlashMenu(skills, true)).toEqual([enabledSkill]);
  });
});

describe("workspace provider snapshots", () => {
  it("uses the cwd snapshot after a provider session has populated it", () => {
    expect(resolveProviderSkillsForCwd(provider, "/workspace/project-a")).toEqual([
      { name: "project", path: "/workspace/project-a/SKILL.md", enabled: true },
    ]);
    expect(resolveProviderSlashCommandsForCwd(provider, "/workspace/project-a")).toEqual([
      { name: "project" },
    ]);
  });

  it("keeps the machine snapshot before this cwd has a provider snapshot", () => {
    expect(resolveProviderSkillsForCwd(provider, "/workspace/project-b")).toEqual(provider.skills);
    expect(resolveProviderSlashCommandsForCwd(provider, null)).toEqual(provider.slashCommands);
  });

  it("uses partial workspace skills and commands while keeping discovery retryable", () => {
    const partial = {
      ...provider,
      workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
        ...snapshot,
        slashCommands: [{ name: "compact" }],
        slashCommandsPending: true,
      })),
    } satisfies ServerProvider;
    expect(resolveProviderSkillsForCwd(partial, "/workspace/project-a")).toEqual(
      provider.workspaceSnapshots[0]?.skills,
    );
    expect(resolveProviderSlashCommandsForCwd(partial, "/workspace/project-a")).toEqual([
      { name: "compact" },
    ]);
    expect(hasCompleteProviderWorkspaceSnapshot(partial, "/workspace/project-a")).toBe(false);
    expect(hasCompleteProviderWorkspaceSnapshot(provider, "/workspace/project-a")).toBe(true);
    expect(hasCompleteProviderWorkspaceSnapshot(provider, "/workspace/project-b")).toBe(false);
    expect(hasCompleteProviderWorkspaceSnapshot(undefined, "/workspace/project-a")).toBe(false);
    expect(hasCompleteProviderWorkspaceSnapshot(provider, null)).toBe(false);
  });
});

describe("skill visibility", () => {
  it("hides and restores skills in both pickers, matching Windows path separators", () => {
    const skills = [
      { name: "review", path: "C:/Users/dev/.agents/skills/review/SKILL.md", enabled: true },
      { name: "deploy", path: "C:/work/.agents/skills/deploy/SKILL.md", enabled: true },
    ];
    const commands = [{ name: "review" }, { name: "deploy" }, { name: "help" }];
    const hidden = applySkillVisibility(skills, commands, [skills[0]!.path.replaceAll("/", "\\")]);
    expect(hidden.skills.map((skill) => skill.name)).toEqual(["deploy"]);
    expect(hidden.slashCommands.map((command) => command.name)).toEqual(["deploy", "help"]);
    const restored = applySkillVisibility(skills, commands, []);
    expect(restored.skills).toBe(skills);
    expect(restored.slashCommands).toBe(commands);
  });
});

it("hides all file aliases and restores them, including Windows drive-letter case", () => {
  const aliases = [
    "C:/Users/dev/.agents/skills/review/SKILL.md",
    "C:/Users/dev/.claude/skills/review/SKILL.md",
  ];
  const skills = [
    { name: "review", enabled: true, path: "c:/Users/dev/.claude/skills/review/SKILL.md" },
  ];
  const hidden = setSkillPathVisibility([], aliases, false);
  expect(applySkillVisibility(skills, [{ name: "review" }], hidden)).toEqual({
    skills: [],
    slashCommands: [],
  });
  const restored = setSkillPathVisibility(hidden, aliases, true);
  expect(restored).toEqual([]);
  expect(applySkillVisibility(skills, [], restored).skills).toEqual(skills);
});

describe("resolveProviderForCwd", () => {
  it("switches workspace options for every model without changing the machine catalog", () => {
    const reasoning = {
      id: "reasoning",
      label: "Reasoning",
      type: "select" as const,
      options: [{ id: "high", label: "High" }],
    };
    const globalAgent = {
      id: "agent",
      label: "Agent",
      type: "select" as const,
      options: [{ id: "build", label: "Build" }],
    };
    const workspaceAgent = {
      ...globalAgent,
      options: [{ id: "readonly", label: "Readonly" }],
    };
    const emptyAgent = { ...globalAgent, options: [] };
    const catalog: ServerProvider = {
      ...provider,
      models: [
        {
          slug: "model",
          name: "Model",
          isCustom: false,
          capabilities: { optionDescriptors: [globalAgent, reasoning] },
        },
        { slug: "custom", name: "Custom", isCustom: true, capabilities: null },
        { slug: "legacy", name: "Legacy", isCustom: false, capabilities: {} },
      ],
      workspaceSnapshots: [
        ...provider.workspaceSnapshots,
        ...[workspaceAgent, emptyAgent].map((agent, index) => ({
          ...provider.workspaceSnapshots[0]!,
          cwd: `/workspace/options-${index}`,
          optionDescriptors: [agent],
        })),
      ],
    };
    const original = structuredClone(catalog);

    for (const [index, agent] of [workspaceAgent, emptyAgent, workspaceAgent].entries()) {
      const scoped = resolveProviderForCwd(catalog, `/workspace/options-${index % 2}`);
      expect(scoped.models.map((model) => model.capabilities?.optionDescriptors)).toEqual([
        expect.arrayContaining([reasoning, agent]),
        [agent],
        [agent],
      ]);
      expect(scoped.models[0]?.capabilities?.optionDescriptors).toHaveLength(2);
    }
    expect(catalog).toEqual(original);
    expect(resolveProviderForCwd(catalog, "/workspace/unknown")).toBe(catalog);
    expect(resolveProviderForCwd(catalog, "/workspace/project-a")).toBe(catalog);
    expect(resolveProviderForCwd(catalog, null)).toBe(catalog);
  });
});
