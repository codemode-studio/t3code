import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ProviderProfileId,
  ThreadId,
  VcsProcessExitError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { GitHubCliAccountEnvironment, GitHubCliAccountSelection } from "./GitHubCli.ts";
import * as GitHubCliAccountSelectionLayer from "./GitHubCliAccountSelection.ts";

const at = "2026-09-01T00:00:00.000Z";
const personal = { host: "github.com", login: "personal" };
const work = { host: "github.com", login: "work" };

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [id, root] of [
    ["project-work", "/src/work"],
    ["project-personal", "/src/personal"],
  ] as const) {
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
      )
      VALUES (${id}, ${id}, ${root}, '[]', ${at}, ${at}, NULL)
    `;
  }
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, payload_json
    )
    VALUES (
      'thread-work', 'project-work', 'Work thread', 'codex', 'full-access', 'default',
      ${at}, ${at}, '{"worktreePath":"/worktrees/work-feature"}'
    )
  `;
});

const persistence = SqlitePersistenceMemory;

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

it.effect("uses the account of the project's profile when nothing else picks one", () =>
  Effect.gen(function* () {
    yield* seed;
    const selection = yield* GitHubCliAccountSelection;
    assert.deepStrictEqual(yield* selection.forCwd("/worktrees/work-feature"), work);
    assert.strictEqual(yield* selection.forCwd("/src/personal"), null);
  }).pipe(
    Effect.provide(
      GitHubCliAccountSelectionLayer.layer.pipe(
        Layer.provide(
          ServerSettings.layerTest({
            providerProfiles: {
              [ProviderProfileId.make("work")]: {
                name: "Work",
                instanceIds: [],
                defaultModelSelection: null,
                githubCliAccount: work,
              },
            },
            projectSettingsOverrides: {
              [ProjectId.make("project-work")]: {
                providerProfileId: ProviderProfileId.make("work"),
              },
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

it.effect("follows selection changes, token expiry, and a recovered login", () => {
  let selected = work;
  let issued = 0;
  let signedOut = false;
  const lookups: Array<string | undefined> = [];
  return Effect.gen(function* () {
    const environment = yield* GitHubCliAccountEnvironment;
    const token = Effect.map(environment.forCwd("/src/work"), (env) => env.GH_TOKEN);

    assert.strictEqual(yield* token, "work-1");
    // A new selection applies to the next launch without waiting for expiry.
    selected = personal;
    assert.strictEqual(yield* token, "personal-2");
    selected = work;
    assert.strictEqual(yield* token, "work-1");

    // Tokens are re-read once the cached one is a minute old.
    yield* TestClock.adjust("61 seconds");
    assert.strictEqual(yield* token, "work-3");

    // A failed lookup is not cached, so signing back in works on the next launch.
    yield* TestClock.adjust("61 seconds");
    signedOut = true;
    assert.strictEqual(yield* token, undefined);
    signedOut = false;
    assert.strictEqual(yield* token, "work-5");
    assert.deepStrictEqual(lookups, ["work", "personal", "work", "work", "work"]);
  }).pipe(
    Effect.provide(
      GitHubCliAccountSelectionLayer.environmentLayer.pipe(
        Layer.provide(
          Layer.succeed(GitHubCliAccountSelection, {
            forCwd: () => Effect.sync(() => selected),
          }),
        ),
        Layer.provide(
          Layer.mock(VcsProcess.VcsProcess)({
            run: (input) =>
              Effect.suspend(() => {
                lookups.push(input.args[5]);
                issued += 1;
                return signedOut
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
                      stdout: `${input.args[5]}-${issued}\n`,
                      stderr: "",
                      stdoutTruncated: false,
                      stderrTruncated: false,
                    });
              }),
          }),
        ),
      ),
    ),
  );
});
