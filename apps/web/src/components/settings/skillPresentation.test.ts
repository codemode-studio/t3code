import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SettingsSkill } from "./projectSkillFiles";
import { groupSkills, skillDisplayPath, skillSourceKey } from "./skillPresentation";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");

function skill(overrides: Partial<SettingsSkill> & Pick<SettingsSkill, "name" | "path">) {
  return {
    description: "",
    aliases: [overrides.path],
    source: "agents",
    scope: "personal",
    environmentId: local,
    environmentLabel: "This Mac",
    ...overrides,
  } satisfies SettingsSkill;
}

describe("skill presentation", () => {
  it("shortens personal skill paths to the home dot-folder and drops SKILL.md", () => {
    expect(skillDisplayPath({ path: "/Users/dev/.agents/skills/animate/SKILL.md" }, null)).toBe(
      "~/.agents/skills/animate",
    );
  });

  it("collapses generated folder names such as synced account IDs", () => {
    expect(
      skillDisplayPath(
        {
          path: "/Users/dev/.claude/skills/synced/9ee4f194-76ea-4cf9-b250-c1a540fcd1b3_0216b96c-134a-45c0-af50-4c78f19e6d11/docs/SKILL.md",
        },
        null,
      ),
    ).toBe("~/.claude/skills/synced/…/docs");
  });

  it("shows project skill paths from the project folder", () => {
    expect(
      skillDisplayPath(
        { path: "/Users/dev/Git/t3code/.claude/skills/review/SKILL.md" },
        { root: "/Users/dev/Git/t3code", label: "t3code" },
      ),
    ).toBe("t3code/.claude/skills/review");
  });

  it("tells apart selected projects that share a folder name", () => {
    const groups = groupSkills(
      [
        skill({
          name: "one",
          path: "/src/one/app/.agents/skills/review/SKILL.md",
          scope: "project",
        }),
        skill({
          name: "two",
          path: "/src/two/app/.agents/skills/review/SKILL.md",
          scope: "project",
        }),
      ],
      [
        {
          environmentId: local,
          environmentLabel: "This Mac",
          workspaceRoots: ["/src/one/app", "/src/two/app", "/src/solo"],
        },
      ],
    );

    expect(groups.map((group) => [group.label, group.skills[0]?.displayPath])).toEqual([
      ["one/app", "one/app/.agents/skills/review"],
      ["two/app", "two/app/.agents/skills/review"],
    ]);
  });

  it("puts personal skills first, then one group per project and environment", () => {
    const targets = [
      { environmentId: local, environmentLabel: "This Mac", workspaceRoots: ["/repo/app"] },
      { environmentId: remote, environmentLabel: "Devbox", workspaceRoots: ["/srv/app"] },
    ];
    const groups = groupSkills(
      [
        skill({ name: "ship", path: "/repo/app/.agents/skills/ship/SKILL.md", scope: "project" }),
        skill({ name: "animate", path: "/Users/dev/.agents/skills/animate/SKILL.md" }),
        skill({
          name: "deploy",
          path: "/srv/app/.codex/skills/deploy/SKILL.md",
          scope: "project",
          source: "codex",
          environmentId: remote,
          environmentLabel: "Devbox",
        }),
      ],
      targets,
    );

    expect(
      groups.map((group) => [group.label, group.environmentLabel, group.skills.map((s) => s.name)]),
    ).toEqual([
      ["Personal", "This Mac", ["animate"]],
      ["app", "Devbox", ["deploy"]],
      ["app", "This Mac", ["ship"]],
    ]);
  });

  it("maps folder families and provider drivers to one source presentation", () => {
    expect(skillSourceKey("claude")).toBe("claude");
    expect(skillSourceKey("claudeAgent")).toBe("claude");
    expect(skillSourceKey("hermes")).toBe("other");
  });
});
