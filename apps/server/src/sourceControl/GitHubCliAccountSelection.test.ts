import { assert, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, ThreadId, VcsProcessExitError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ProjectionThreadRepositoryLive } from "../persistence/Layers/ProjectionThreads.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { GitHubCliAccountEnvironment, GitHubCliAccountSelection } from "./GitHubCli.ts";
import * as GitHubCliAccountSelectionLayer from "./GitHubCliAccountSelection.ts";

const at = "2026-09-01T00:00:00.000Z";
const personal = { host: "github.com", login: "personal" };
const work = { host: "github.com", login: "work" };

const seed = Effect.gen(function* () {
  const projects = yield* ProjectionProjectRepository;
  const threads = yield* ProjectionThreadRepository;
  for (const [id, root] of [
    ["project-work", "/src/work"],
    ["project-personal", "/src/personal"],
  ] as const) {
    yield* projects.upsert({
      projectId: ProjectId.make(id),
      title: id,
      workspaceRoot: root,
      defaultModelSelection: null,
      defaultThreadEnvMode: null,
      autoPull: false,
      scripts: [],
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    });
  }
  yield* threads.upsert({
    threadId: ThreadId.make("thread-work"),
    projectId: ProjectId.make("project-work"),
    title: "Work thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature",
    worktreePath: "/worktrees/work-feature",
    latestTurnId: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    latestUserMessageAt: null,
    pendingApprovalCount: 0,
    pendingUserInputCount: 0,
    hasActionableProposedPlan: 0,
    deletedAt: null,
  });
});

const persistence = Layer.mergeAll(
  ProjectionProjectRepositoryLive,
  ProjectionThreadRepositoryLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.effect("resolves the project override for its root and its thread worktrees", () =>
  Effect.gen(function* () {
    yield* seed;
    const selection = yield* GitHubCliAccountSelection;
    assert.deepStrictEqual(yield* selection.forCwd("/src/work"), work);
    assert.deepStrictEqual(yield* selection.forCwd("/worktrees/work-feature"), work);
    assert.deepStrictEqual(yield* selection.forCwd("/src/personal"), personal);
    // Outside any project the environment default applies.
    assert.deepStrictEqual(yield* selection.forCwd("/tmp/elsewhere"), personal);
  }).pipe(
    Effect.provide(
      GitHubCliAccountSelectionLayer.layer.pipe(
        Layer.provide(
          ServerSettings.layerTest({
            githubCliAccount: personal,
            projectSettingsOverrides: {
              [ProjectId.make("project-work")]: { githubCliAccount: work },
            },
          }),
        ),
        Layer.provideMerge(persistence),
      ),
    ),
  ),
);

it.effect("lets a project opt back into the CLI's active login", () =>
  Effect.gen(function* () {
    yield* seed;
    const selection = yield* GitHubCliAccountSelection;
    assert.strictEqual(yield* selection.forCwd("/worktrees/work-feature"), null);
    assert.deepStrictEqual(yield* selection.forCwd("/src/personal"), personal);
  }).pipe(
    Effect.provide(
      GitHubCliAccountSelectionLayer.layer.pipe(
        Layer.provide(
          ServerSettings.layerTest({
            githubCliAccount: personal,
            projectSettingsOverrides: {
              [ProjectId.make("project-work")]: { githubCliAccount: null },
            },
          }),
        ),
        Layer.provideMerge(persistence),
      ),
    ),
  ),
);

it.effect("hands processes the selected login's token, or nothing when it is unreadable", () => {
  const lookups: Array<ReadonlyArray<string>> = [];
  const accounts: Record<string, { host: string; login: string }> = {
    "/work": work,
    "/enterprise": { host: "GitHub.Example.test", login: "enterprise" },
    "/gone": { host: "github.com", login: "gone" },
  };
  return Effect.gen(function* () {
    const environment = yield* GitHubCliAccountEnvironment;
    assert.deepStrictEqual(yield* environment.forCwd("/work"), {
      GH_TOKEN: "token-for-work",
      GITHUB_TOKEN: "token-for-work",
    });
    assert.deepStrictEqual(yield* environment.forCwd("/enterprise"), {
      GH_ENTERPRISE_TOKEN: "token-for-enterprise",
      GITHUB_ENTERPRISE_TOKEN: "token-for-enterprise",
    });
    // A signed-out login falls back to gh's active login instead of blocking the process.
    assert.deepStrictEqual(yield* environment.forCwd("/gone"), {});
    assert.deepStrictEqual(yield* environment.forCwd("/unselected"), {});
    yield* environment.forCwd("/work");
    assert.deepStrictEqual(lookups, [
      ["auth", "token", "--hostname", "github.com", "--user", "work"],
      ["auth", "token", "--hostname", "github.example.test", "--user", "enterprise"],
      ["auth", "token", "--hostname", "github.com", "--user", "gone"],
    ]);
  }).pipe(
    Effect.provide(
      GitHubCliAccountSelectionLayer.environmentLayer.pipe(
        Layer.provide(
          Layer.succeed(GitHubCliAccountSelection, {
            forCwd: (cwd) => Effect.succeed(accounts[cwd] ?? null),
          }),
        ),
        Layer.provide(
          Layer.mock(VcsProcess.VcsProcess)({
            run: (input) => {
              lookups.push(input.args);
              const login = input.args[5];
              return login === "gone"
                ? Effect.fail(
                    new VcsProcessExitError({
                      operation: input.operation,
                      command: "gh",
                      cwd: input.cwd,
                      exitCode: 1,
                      failureKind: "authentication",
                      detail: "no oauth token found",
                    }),
                  )
                : Effect.succeed({
                    exitCode: ChildProcessSpawner.ExitCode(0),
                    stdout: `token-for-${login}\n`,
                    stderr: "",
                    stdoutTruncated: false,
                    stderrTruncated: false,
                  });
            },
          }),
        ),
      ),
    ),
  );
});
