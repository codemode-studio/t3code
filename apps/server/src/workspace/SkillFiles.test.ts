// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { createSkillFile, listSkillFiles } from "./SkillFiles.ts";

let temp: string;
let home: string;
let project: string;
beforeEach(async () => {
  temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-skills-"));
  home = NodePath.join(temp, "custom-home");
  project = NodePath.join(temp, "project");
  await Promise.all([NodeFSP.mkdir(home), NodeFSP.mkdir(project)]);
});
afterEach(async () => {
  await NodeFSP.rm(temp, { recursive: true, force: true });
});
async function writeSkill(
  root: string,
  name: string,
  contents = `---\nname: ${name}\ndescription: Original\n---\n\nInstructions`,
) {
  const file = NodePath.join(root, ".agents", "skills", name, "SKILL.md");
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  await NodeFSP.writeFile(file, contents);
  return file;
}
function provider(skills: ServerProvider["skills"]): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-24T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills,
  };
}

describe("file skills catalog", () => {
  it("follows linked folders and linked roots outside the project and deduplicates personal links", async () => {
    const shared = NodePath.join(temp, "shared");
    await writeSkill(shared, "review");
    await NodeFSP.mkdir(NodePath.join(project, ".agents"));
    await NodeFSP.symlink(
      NodePath.join(shared, ".agents", "skills"),
      NodePath.join(project, ".agents", "skills"),
      "dir",
    );
    let result = await listSkillFiles({ workspaceRoots: [project] }, [], home);
    expect(result.skills.map((skill) => [skill.name, skill.scope])).toEqual([
      ["review", "project"],
    ]);
    await NodeFSP.mkdir(NodePath.join(home, ".agents", "skills"), { recursive: true });
    await NodeFSP.symlink(
      NodePath.join(shared, ".agents", "skills", "review"),
      NodePath.join(home, ".agents", "skills", "review"),
      "dir",
    );
    const providerAlias = NodePath.join(temp, "provider-alias");
    await NodeFSP.symlink(
      NodePath.join(shared, ".agents", "skills", "review"),
      providerAlias,
      "dir",
    );
    const providerFile = NodePath.join(providerAlias, "SKILL.md");
    result = await listSkillFiles(
      { workspaceRoots: [project] },
      [provider([{ name: "review", path: providerFile, scope: "project", enabled: true }])],
      home,
    );
    expect(result.errors).toEqual([]);
    expect(result.skills.map((skill) => [skill.name, skill.scope])).toEqual([
      ["review", "personal"],
    ]);
    expect(result.skills[0]?.aliases).toEqual(
      [
        NodePath.join(home, ".agents", "skills", "review", "SKILL.md"),
        NodePath.join(project, ".agents", "skills", "review", "SKILL.md"),
        NodePath.join(shared, ".agents", "skills", "review", "SKILL.md"),
        providerFile,
      ].sort(),
    );
  });

  it("reads all skills after 300 candidates including later projects and personal skills", async () => {
    await Promise.all(
      Array.from({ length: 310 }, (_, index) => writeSkill(project, `skill-${index}`)),
    );
    await Promise.all(
      Array.from({ length: 310 }, (_, index) =>
        NodeFSP.mkdir(NodePath.join(project, ".agents", "skills", `empty-${index}`)),
      ),
    );
    const second = NodePath.join(temp, "second");
    await writeSkill(second, "second-project");
    await writeSkill(home, "personal");
    const result = await listSkillFiles({ workspaceRoots: [project, second] }, [], home);
    expect(result.skills).toHaveLength(312);
    expect(result.skills.map((skill) => skill.name)).toContain("personal");
    expect(result.skills.map((skill) => skill.name)).toContain("second-project");
    expect(result.errors).toEqual([]);
  });

  it("uses declared names and YAML folded, literal and quoted descriptions without returning bodies", async () => {
    await writeSkill(
      project,
      "folder",
      "---\nname: declared-name\ndescription: >\n  Review changes.\n  Find bugs.\n---\n" +
        "BODY".repeat(300_000),
    );
    await writeSkill(project, "literal", "---\ndescription: |\n  First line\n  Second line\n---\n");
    await writeSkill(
      project,
      "quoted",
      '---\ndescription: "A: description # with punctuation"\n---\n',
    );
    const result = await listSkillFiles({ workspaceRoots: [project] }, [], home);
    expect(result.errors).toEqual([]);
    expect(result.skills.map(({ name, description }) => [name, description])).toEqual([
      ["declared-name", "Review changes. Find bugs."],
      ["literal", "First line\nSecond line"],
      ["quoted", "A: description # with punctuation"],
    ]);
    expect(JSON.stringify(result)).not.toContain("BODY");
    expect(JSON.stringify(result).length).toBeLessThan(2000);
  });

  it("refreshes changed and deleted files even when the provider inventory stays stale", async () => {
    const file = await writeSkill(home, "review");
    const providers = [
      provider([{ name: "stale", description: "Stale", path: file, scope: "user", enabled: true }]),
    ];
    const list = () => listSkillFiles({ workspaceRoots: [project] }, providers, home);
    expect((await list()).skills[0]?.description).toBe("Original");
    await writeSkill(home, "review", "---\nname: renamed\ndescription: Updated\n---\n");
    expect((await list()).skills[0]).toMatchObject({ name: "renamed", description: "Updated" });
    await NodeFSP.unlink(file);
    expect((await list()).skills).toEqual([]);
  });

  it("labels custom home skills personal even if home is selected and excludes system files through links", async () => {
    await writeSkill(home, "personal");
    const system = NodePath.join(home, ".codex", "skills", ".system", "builtin");
    await NodeFSP.mkdir(system, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(system, "SKILL.md"), "---\nname: builtin\n---\n");
    await NodeFSP.symlink(
      system,
      NodePath.join(home, ".agents", "skills", "linked-builtin"),
      "dir",
    );
    const result = await listSkillFiles(
      { workspaceRoots: [home] },
      [
        provider([
          {
            name: "builtin",
            path: NodePath.join(system, "SKILL.md"),
            enabled: true,
            scope: "system",
          },
        ]),
      ],
      home,
    );
    expect(result.skills.map(({ name, scope }) => [name, scope])).toEqual([
      ["personal", "personal"],
    ]);
  });

  it("keeps provider built-ins hidden even in a standard skills folder", async () => {
    const file = await writeSkill(project, "built-in");
    const result = await listSkillFiles(
      { workspaceRoots: [project] },
      [provider([{ name: "built-in", path: file, scope: "builtin", enabled: true }])],
      home,
    );
    expect(result.skills).toEqual([]);
  });

  it("reports malformed or oversized frontmatter instead of silently showing a complete catalog", async () => {
    await writeSkill(project, "bad", "---\nname: [invalid\n---\n");
    await writeSkill(project, "huge", "---\ndescription: " + "x".repeat(20_000) + "\n---\n");
    const result = await listSkillFiles({ workspaceRoots: [project] }, [], home);
    expect(result.errors).toHaveLength(2);
    expect(result.skills).toEqual([]);
  });

  it("does not include skills from unselected projects", async () => {
    const otherFile = await writeSkill(NodePath.join(temp, "other"), "other");
    await writeSkill(project, "selected");
    const result = await listSkillFiles(
      { workspaceRoots: [project] },
      [provider([{ name: "other", path: otherFile, enabled: true, scope: "project" }])],
      home,
    );
    expect(result.skills.map((skill) => skill.name)).toEqual(["selected"]);
  });
});

describe("create skill", () => {
  it("creates personal and project skills with escaped metadata and preserves existing files", async () => {
    const input = {
      name: "new-skill",
      description: "Line one\nLine two: # quoted",
      instructions: "Review the changes.",
    };
    const personal = await createSkillFile(input, home);
    const local = await createSkillFile({ ...input, cwd: project }, home);
    expect(personal.scope).toBe("personal");
    expect(local.scope).toBe("project");
    const result = await listSkillFiles({ workspaceRoots: [project] }, [], home);
    expect(result.skills).toHaveLength(2);
    expect(result.skills.every((skill) => skill.description === input.description)).toBe(true);
    await expect(
      createSkillFile({ ...input, instructions: "Overwrite" }, home),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await NodeFSP.readFile(personal.path, "utf8")).toContain("Review the changes.");
  });
  it("rejects path traversal before writing", async () => {
    await expect(
      createSkillFile({ name: "../escape", description: "", instructions: "text" }, home),
    ).rejects.toThrow();
    expect(await NodeFSP.readdir(home)).toEqual([]);
  });
});
