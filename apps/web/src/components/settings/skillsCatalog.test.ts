import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { collectSettingsSkills } from "./skillsCatalog";

const environmentId = EnvironmentId.make("local");
const provider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-24T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [
    {
      name: "animate",
      path: "/home/dev/.agents/skills/animate/SKILL.md",
      scope: "project",
      enabled: true,
    },
    {
      name: "imagegen",
      path: "/home/dev/.codex/skills/.system/imagegen/SKILL.md",
      scope: "system",
      enabled: true,
    },
  ],
  workspaceSnapshots: [
    {
      cwd: "/home/dev/work/app",
      checkedAt: "2026-09-24T00:01:00.000Z",
      slashCommands: [],
      skills: [
        {
          name: "animate",
          path: "/home/dev/.agents/skills/animate/SKILL.md",
          scope: "project",
          enabled: true,
        },
        {
          name: "deploy",
          path: "/home/dev/work/app/.agents/skills/deploy/SKILL.md",
          scope: "project",
          enabled: true,
        },
        {
          name: "built-in",
          path: "/opt/provider/skills/built-in/SKILL.md",
          scope: "system",
          enabled: true,
        },
      ],
    },
  ],
} satisfies ServerProvider;

describe("collectSettingsSkills", () => {
  it("shows selected project skills, labels home .agents skills personal, and drops provider built-ins", () => {
    const skills = collectSettingsSkills([
      {
        environmentId,
        label: "Local",
        providers: [provider],
        workspaceRoots: ["/home/dev/work/app"],
      },
    ]);
    expect(skills.map((skill) => [skill.name, skill.scope])).toEqual([
      ["animate", "personal"],
      ["deploy", "project"],
    ]);
  });

  it("keeps project skills out of an environment-only selection", () => {
    const skills = collectSettingsSkills([
      {
        environmentId,
        label: "Local",
        providers: [provider],
        workspaceRoots: [],
      },
    ]);
    expect(skills.map((skill) => skill.name)).toEqual(["animate"]);
  });

  it("keeps the files from separate project checkouts on their owning environments", () => {
    const remoteId = EnvironmentId.make("remote");
    const remoteProvider = {
      ...provider,
      skills: [],
      workspaceSnapshots: [
        {
          cwd: "/srv/app",
          checkedAt: "2026-09-24T00:01:00.000Z",
          slashCommands: [],
          skills: [
            {
              name: "deploy",
              path: "/srv/app/.agents/skills/deploy/SKILL.md",
              scope: "project",
              enabled: true,
            },
          ],
        },
      ],
    } satisfies ServerProvider;
    const skills = collectSettingsSkills([
      {
        environmentId,
        label: "Local",
        providers: [provider],
        workspaceRoots: ["/home/dev/work/app"],
      },
      {
        environmentId: remoteId,
        label: "Remote",
        providers: [remoteProvider],
        workspaceRoots: ["/srv/app"],
      },
    ]);
    expect(
      skills.filter((skill) => skill.name === "deploy").map((skill) => skill.environmentId),
    ).toEqual([environmentId, remoteId]);
  });
});
