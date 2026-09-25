// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as Schema from "effect/Schema";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import {
  SkillsCreateInput,
  type FileSkill,
  type ServerProvider,
  type SkillsListInput,
  type SkillsListResult,
} from "@t3tools/contracts";
import { stringify } from "yaml";

const SKILL_FOLDERS = [
  [".agents/skills", "agents"],
  [".claude/skills", "claude"],
  [".cursor/skills", "cursor"],
  [".codex/skills", "codex"],
  [".opencode/skills", "opencode"],
  [".grok/skills", "grok"],
  [".pi/skills", "pi"],
  [".omp/skills", "omp"],
  [".fx/skills", "fx"],
  [".hermes/skills", "hermes"],
  [".gemini/skills", "antigravity"],
  [".agent/skills", "antigravity"],
] as const;
const PERSONAL_SKILL_FOLDERS = [
  ...SKILL_FOLDERS,
  [".pi/agent/skills", "pi"],
  [".omp/agent/skills", "omp"],
  [".gemini/config/skills", "antigravity"],
  [".gemini/antigravity/skills", "antigravity"],
  [".gemini/antigravity-cli/skills", "antigravity"],
] as const;
const METADATA_BYTES = 16_384;
const decodeCreateInput = Schema.decodeUnknownSync(SkillsCreateInput);
const decodeMetadata = Schema.decodeUnknownSync(
  fromYaml(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      description: Schema.optional(Schema.String),
    }),
  ),
);

function missing(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
function within(file: string, root: string) {
  const relative = NodePath.relative(root, file);
  return (
    relative === "" ||
    (!relative.startsWith(`..${NodePath.sep}`) &&
      relative !== ".." &&
      !NodePath.isAbsolute(relative))
  );
}
function builtin(file: string) {
  return file.replaceAll("\\", "/").includes("/skills/.system/");
}

/** Limit open handles, not catalog size. Cancellation stops scheduling further disk reads. */
async function forEachConcurrent<T>(
  values: readonly T[],
  visit: (value: T) => Promise<void>,
  signal?: AbortSignal,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(16, values.length) }, async () => {
      while (next < values.length) {
        signal?.throwIfAborted();
        const value = values[next++];
        if (value !== undefined) await visit(value);
      }
    }),
  );
}

/** Provider inventories supply extra locations only; disk owns current existence and metadata. */
export async function listSkillFiles(
  input: SkillsListInput,
  providers: readonly ServerProvider[] = [],
  home = NodeOS.homedir(),
  signal?: AbortSignal,
): Promise<SkillsListResult> {
  const roots = [...new Set(input.workspaceRoots.map((root) => NodePath.resolve(root)))];
  const errors: string[] = [];
  const candidates = new Map<string, { scope: FileSkill["scope"]; source: string }>();
  const folders = [
    ...PERSONAL_SKILL_FOLDERS.map(([folder, source]) => ({
      directory: NodePath.join(home, folder),
      source,
      scope: "personal" as const,
    })),
    ...roots.flatMap((root) =>
      SKILL_FOLDERS.map(([folder, source]) => ({
        directory: NodePath.join(root, folder),
        source,
        scope: "project" as const,
      })),
    ),
  ];
  const personalRoots = PERSONAL_SKILL_FOLDERS.map(([folder]) => NodePath.join(home, folder));
  const addCandidate = (file: string, scope: FileSkill["scope"], source: string) => {
    if (builtin(file)) return;
    const personal = personalRoots.some((root) => within(file, root));
    const previous = candidates.get(file);
    candidates.set(file, {
      scope: personal || previous?.scope === "personal" ? "personal" : scope,
      source: previous?.source ?? source,
    });
  };
  await forEachConcurrent(
    folders,
    async ({ directory, scope, source }) => {
      try {
        const entries = await NodeFSP.readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink()))
            continue;
          addCandidate(NodePath.join(directory, entry.name, "SKILL.md"), scope, source);
        }
      } catch (error) {
        if (!missing(error)) errors.push(`Could not read ${directory}`);
      }
    },
    signal,
  );
  const excludedPaths = new Set<string>();
  const providerPaths = new Set<string>();
  for (const provider of providers) {
    const hints = [
      ...provider.skills,
      ...(provider.workspaceSnapshots
        ?.filter((snapshot) => roots.includes(snapshot.cwd))
        .flatMap((snapshot) => snapshot.skills) ?? []),
    ];
    for (const skill of hints) {
      const file = NodePath.resolve(skill.path);
      if (["system", "builtin", "built-in"].includes(skill.scope?.toLowerCase() ?? "")) {
        excludedPaths.add(file);
        continue;
      }
      if (!provider.enabled || !provider.installed) continue;
      providerPaths.add(file);
      const homeSkill =
        within(file, home) && !roots.some((root) => root !== home && within(file, root));
      if (
        homeSkill &&
        !["project", "repo", "workspace", "local"].includes(skill.scope?.toLowerCase() ?? "")
      ) {
        addCandidate(file, "personal", provider.driver);
      } else if (roots.some((root) => within(file, root))) {
        addCandidate(file, "project", provider.driver);
      } else if (["user", "personal"].includes(skill.scope?.toLowerCase() ?? "")) {
        addCandidate(file, "personal", provider.driver);
      }
    }
  }
  await forEachConcurrent(
    [...excludedPaths],
    async (file) => {
      try {
        excludedPaths.add(await NodeFSP.realpath(file));
      } catch {
        /* A missing built-in has no catalog entry. */
      }
    },
    signal,
  );
  const skills = new Map<string, FileSkill>();
  await forEachConcurrent(
    [...candidates],
    async ([file, location]) => {
      try {
        const canonical = await NodeFSP.realpath(file);
        if (builtin(canonical) || excludedPaths.has(file) || excludedPaths.has(canonical)) return;
        if (!(await NodeFSP.stat(file)).isFile()) return;
        const handle = await NodeFSP.open(file, "r");
        let contents: string;
        try {
          const buffer = Buffer.alloc(METADATA_BYTES);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          contents = buffer.toString("utf8", 0, bytesRead);
        } finally {
          await handle.close();
        }
        const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents);
        if (/^\uFEFF?---\r?\n/.test(contents) && !match) throw new Error("Incomplete frontmatter");
        const metadata = match ? decodeMetadata(match[1]) : {};
        const row = {
          ...location,
          path: file,
          aliases: [file, canonical],
          name: metadata.name?.trim() || NodePath.basename(NodePath.dirname(file)),
          description: metadata.description?.trim() ?? "",
        };
        const previous = skills.get(canonical);
        const aliases = [...new Set([...(previous?.aliases ?? []), ...row.aliases])].sort();
        if (
          !previous ||
          (row.scope === "personal" && previous.scope !== "personal") ||
          (row.scope === previous.scope && row.path.localeCompare(previous.path) < 0)
        )
          skills.set(canonical, { ...row, aliases });
        else skills.set(canonical, { ...previous, aliases });
      } catch (error) {
        if (!missing(error)) errors.push(`Could not read skill metadata: ${file}`);
      }
    },
    signal,
  );
  // A provider can report the resolved target outside a linked project directory.
  // Such paths are aliases of already-discovered files, not additional catalog entries.
  await forEachConcurrent(
    [...providerPaths].filter((file) => !candidates.has(file)),
    async (file) => {
      try {
        const canonical = await NodeFSP.realpath(file);
        const skill = skills.get(canonical);
        if (skill)
          skills.set(canonical, {
            ...skill,
            aliases: [...new Set([...skill.aliases, file])].sort(),
          });
      } catch {
        /* Missing provider inventory entries are discarded. */
      }
    },
    signal,
  );
  return {
    skills: [...skills.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
    ),
    errors: errors.sort(),
  };
}

/** Exclusive creation preserves an existing skill, including a linked file. */
export async function createSkillFile(
  input: SkillsCreateInput,
  home = NodeOS.homedir(),
): Promise<FileSkill> {
  const validated = decodeCreateInput(input);
  const root = validated.cwd ?? home;
  const file = NodePath.join(root, ".agents", "skills", validated.name, "SKILL.md");
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  const metadata = stringify({ name: validated.name, description: validated.description });
  await NodeFSP.writeFile(file, `---\n${metadata}---\n\n${validated.instructions}\n`, {
    flag: "wx",
  });
  return {
    name: validated.name,
    description: validated.description,
    path: file,
    aliases: [...new Set([file, await NodeFSP.realpath(file)])],
    scope: within(file, NodePath.join(home, ".agents", "skills")) ? "personal" : "project",
    source: "agents",
  };
}
