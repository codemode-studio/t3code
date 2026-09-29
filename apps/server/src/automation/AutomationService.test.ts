import {
  type AutomationConfig,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderProfileId,
  type ServerProvider,
  type ServerSettings,
  type VcsCreateWorktreeInput,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../config.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "../orchestration/Services/ThreadDeletionReactor.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { GitHubCli, GitHubPullRequestNotFoundError } from "../sourceControl/GitHubCli.ts";
import * as AutomationService from "./AutomationService.ts";

const PROJECT_ID = ProjectId.make("automation-project");
const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const PROJECT: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "Automation project",
  workspaceRoot: "/tmp/automation-project",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const CONFIG: AutomationConfig = {
  name: "Nightly review",
  enabled: true,
  projectId: PROJECT_ID,
  triggers: [{ type: "schedule", cadence: "daily", hour: 3, minute: 0, weekday: 1 }],
  prompt: "Review yesterday's commits.",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  workingCopy: "local",
  conversation: "fresh",
  catchUpMinutes: 60,
};

const makeLayer = (input: {
  readonly stateDir: string;
  readonly commands: Ref.Ref<ReadonlyArray<OrchestrationCommand>>;
  readonly project: OrchestrationProjectShell | null;
  readonly settings?: Parameters<typeof ServerSettingsService.layerTest>[0];
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly git?: Partial<GitWorkflowService["Service"]>;
  readonly gitHubCli?: Partial<GitHubCli["Service"]>;
}) =>
  AutomationService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            Ref.update(input.commands, (commands) => [...commands, command]).pipe(
              Effect.as({ sequence: 1 }),
            ),
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () => Effect.succeed(Option.fromNullishOr(input.project)),
          getThreadShellById: () => Effect.succeed(Option.none()),
        }),
        Layer.mock(ThreadDeletionReactor)({ drainThrough: () => Effect.void }),
        Layer.mock(GitWorkflowService)(input.git ?? {}),
        Layer.mock(ProjectSetupScriptRunner)({
          runForThread: () => Effect.succeed({ status: "no-script" }),
        }),
        Layer.mock(GitHubCli)(input.gitHubCli ?? {}),
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed(input.providers ?? []) }),
        ServerSettingsService.layerTest(input.settings),
        ServerConfig.layerTest(process.cwd(), input.stateDir),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const withService = <A, E>(
  project: OrchestrationProjectShell | null,
  body: (
    service: AutomationService.AutomationService["Service"],
    context: {
      readonly stateDir: string;
      readonly commands: Ref.Ref<ReadonlyArray<OrchestrationCommand>>;
    },
  ) => Effect.Effect<A, E, Scope.Scope>,
  {
    automationsFile,
    ...environment
  }: Pick<Parameters<typeof makeLayer>[0], "settings" | "providers" | "git" | "gitHubCli"> & {
    /** Seeds `automations.json` before the service reads it. */
    readonly automationsFile?: unknown;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-automations-" });
    if (automationsFile !== undefined) {
      const config = yield* ServerConfig.pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), stateDir)),
      );
      yield* fs.writeFileString(
        path.join(config.stateDir, "automations.json"),
        yield* encodeJson(automationsFile),
      );
    }
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const service = yield* AutomationService.AutomationService.pipe(
      Effect.provide(makeLayer({ stateDir, commands, project, ...environment })),
    );
    return yield* body(service, { stateDir, commands });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("AutomationService", () => {
  it.effect("persists automations and restores them on the next start", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-automations-" });
      const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const layer = makeLayer({ stateDir, commands, project: PROJECT });

      const created = yield* Effect.gen(function* () {
        const service = yield* AutomationService.AutomationService;
        return yield* service.create(CONFIG);
      }).pipe(Effect.provide(layer));

      const config = yield* ServerConfig.pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), stateDir)),
      );
      const onDisk = yield* fs.readFileString(path.join(config.stateDir, "automations.json"));
      assert.include(onDisk, "Nightly review");

      // A fresh service instance reads the file back.
      const restored = yield* Effect.gen(function* () {
        const service = yield* AutomationService.AutomationService;
        return yield* service.changes.pipe(Stream.runHead);
      }).pipe(Effect.provide(layer));
      assert.deepStrictEqual(
        Option.map(restored, (snapshot) => snapshot.automations.map((entry) => entry.id)),
        Option.some([created.id]),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a local run creates a thread and starts a turn with the instructions", () =>
    withService(PROJECT, (service, { commands }) =>
      Effect.gen(function* () {
        const created = yield* service.create(CONFIG);
        const run = yield* service.runNow(created.id);
        assert.strictEqual(run.error, null);
        assert.isNotNull(run.threadId);

        const dispatched = yield* Ref.get(commands);
        assert.deepStrictEqual(
          dispatched.map((command) => command.type),
          ["thread.create", "thread.turn.start"],
        );
        const [create, turn] = dispatched;
        assert.strictEqual(create?.type === "thread.create" && create.worktreePath, null);
        assert.strictEqual(
          turn?.type === "thread.turn.start" && turn.message.text,
          "Review yesterday's commits.",
        );

        const snapshot = yield* service.changes.pipe(Stream.runHead);
        const runs = Option.map(snapshot, (value) => value.automations[0]?.runs.length);
        assert.deepStrictEqual(runs, Option.some(1));
      }),
    ),
  );

  it.effect("records a failed run instead of failing when the project is gone", () =>
    withService(null, (service, { commands }) =>
      Effect.gen(function* () {
        const created = yield* service.create(CONFIG);
        const run = yield* service.runNow(created.id);
        assert.strictEqual(run.threadId, null);
        assert.include(run.error ?? "", "project no longer exists");
        assert.deepStrictEqual(yield* Ref.get(commands), []);
      }),
    ),
  );

  it.effect(
    "an automation on a profiled project runs inside the profile, not on the environment default",
    () => {
      const acmeClaude = ProviderInstanceId.make("cc_a");
      const otherClaude = ProviderInstanceId.make("cc_b");
      const acme = ProviderProfileId.make("acme");
      const provider = (instanceId: ProviderInstanceId) =>
        ({
          instanceId,
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
          installed: true,
          status: "ready",
          auth: { status: "authenticated" },
          models: [{ slug: "opus", name: "Opus", isCustom: false, isDefault: true }],
        }) as unknown as ServerProvider;
      const settings: Partial<ServerSettings> = {
        providerInstances: {
          [acmeClaude]: { driver: ProviderDriverKind.make("claudeAgent") },
          [otherClaude]: { driver: ProviderDriverKind.make("claudeAgent") },
        },
        // The environment default belongs to another profile's account.
        defaultModelSelection: { instanceId: otherClaude, model: "opus" },
        providerProfiles: {
          [acme]: { name: "Acme", instanceIds: [acmeClaude], defaultModelSelection: null },
        },
        projectSettingsOverrides: { [PROJECT_ID]: { providerProfileId: acme } },
      };
      return withService(
        PROJECT,
        (service, { commands }) =>
          Effect.gen(function* () {
            const created = yield* service.create({ ...CONFIG, modelSelection: null });
            const run = yield* service.runNow(created.id);
            assert.strictEqual(run.error, null);
            const turn = (yield* Ref.get(commands)).find(
              (command) => command.type === "thread.turn.start",
            );
            assert.deepStrictEqual(turn?.type === "thread.turn.start" && turn.modelSelection, {
              instanceId: acmeClaude,
              model: "opus",
            });
          }),
        { settings, providers: [provider(otherClaude), provider(acmeClaude)] },
      );
    },
  );

  describe("pull request runs", () => {
    const PR_CONFIG: AutomationConfig = {
      ...CONFIG,
      name: "Review new pull requests",
      triggers: [{ type: "github", event: "pull_request.opened" }],
      prompt: "Review the pull request.",
      workingCopy: "worktree",
    };
    const PR_LIST = JSON.stringify([
      {
        number: 30,
        title: "feat(web): add tooltip",
        url: "https://github.com/acme/app/pull/30",
        createdAt: "2026-09-28T15:00:00.000Z",
        isDraft: false,
      },
    ]);
    const output = (stdout: string) => ({
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    });

    // Watching started before the PR was opened, so the first poll picks it up.
    const PR_AUTOMATIONS_FILE = {
      automations: [
        {
          ...PR_CONFIG,
          id: "pr-review",
          createdAt: "2026-09-28T00:00:00.000Z",
          updatedAt: "2026-09-28T00:00:00.000Z",
          runs: [],
          scheduleCursor: "2026-09-28T00:00:00.000Z",
          githubCursor: "2026-09-28T00:00:00.000Z",
        },
      ],
    };

    const pollUntilRun = (service: AutomationService.AutomationService["Service"]) =>
      Effect.gen(function* () {
        // Past the poll interval, so the loop's first iteration polls GitHub.
        yield* TestClock.setTime(Date.parse("2026-09-28T16:00:00.000Z"));
        yield* service.start();
        const snapshot = yield* service.changes.pipe(
          Stream.filter((value) => (value.automations[0]?.runs.length ?? 0) > 0),
          Stream.runHead,
        );
        return Option.getOrThrow(snapshot).automations[0]!.runs[0]!;
      });

    it.effect("reviews the PR head in a detached worktree and links the PR", () =>
      Effect.gen(function* () {
        const worktrees = yield* Ref.make<ReadonlyArray<VcsCreateWorktreeInput>>([]);
        const ghCalls = yield* Ref.make<ReadonlyArray<{ cwd: string; args: string }>>([]);
        yield* withService(
          PROJECT,
          (service, { commands }) =>
            Effect.gen(function* () {
              const run = yield* pollUntilRun(service);
              assert.strictEqual(run.error, null);

              const [worktree] = yield* Ref.get(worktrees);
              assert.strictEqual(worktree?.refName, "HEAD");
              assert.isUndefined(worktree?.newRefName);
              assert.match(worktree?.path ?? "", /\/automation-project\/pr-30-[0-9a-f]{8}$/);
              assert.deepInclude(yield* Ref.get(ghCalls), {
                cwd: worktree!.path!,
                args: "pr checkout 30 --detach",
              });

              const dispatched = yield* Ref.get(commands);
              assert.deepStrictEqual(
                dispatched.map((command) => command.type),
                ["thread.create", "thread.pull-request.link", "thread.turn.start"],
              );
              const [create, link, turn] = dispatched;
              assert.deepStrictEqual(
                create?.type === "thread.create" && [create.branch, create.worktreePath],
                [null, worktree!.path],
              );
              assert.deepStrictEqual(
                link?.type === "thread.pull-request.link" && [link.repository, link.number],
                ["acme/app", 30],
              );
              assert.include(
                turn?.type === "thread.turn.start" ? turn.message.text : "",
                "gh pr checkout 30 --detach",
              );
            }),
          {
            automationsFile: PR_AUTOMATIONS_FILE,
            git: {
              isRepository: () => Effect.succeed(true),
              createWorktree: (input) =>
                Ref.update(worktrees, (all) => [...all, input]).pipe(
                  Effect.as({ worktree: { path: input.path!, refName: input.refName } }),
                ),
            },
            gitHubCli: {
              execute: (input) =>
                Ref.update(ghCalls, (all) => [
                  ...all,
                  { cwd: input.cwd, args: input.args.join(" ") },
                ]).pipe(Effect.as(output(input.args[1] === "list" ? PR_LIST : ""))),
            },
          },
        );
      }),
    );

    it.effect("removes the worktree and records the failure when the checkout fails", () =>
      Effect.gen(function* () {
        const removed = yield* Ref.make<ReadonlyArray<string>>([]);
        yield* withService(
          PROJECT,
          (service, { commands }) =>
            Effect.gen(function* () {
              const run = yield* pollUntilRun(service);
              assert.strictEqual(run.threadId, null);
              assert.isNotNull(run.error);
              assert.match((yield* Ref.get(removed))[0] ?? "", /pr-30-[0-9a-f]{8}$/);
              assert.deepStrictEqual(yield* Ref.get(commands), []);
            }),
          {
            automationsFile: PR_AUTOMATIONS_FILE,
            git: {
              isRepository: () => Effect.succeed(true),
              createWorktree: (input) =>
                Effect.succeed({ worktree: { path: input.path!, refName: input.refName } }),
              removeWorktree: (input) => Ref.update(removed, (all) => [...all, input.path]),
            },
            gitHubCli: {
              execute: (input) =>
                input.args[1] === "list"
                  ? Effect.succeed(output(PR_LIST))
                  : Effect.fail(
                      new GitHubPullRequestNotFoundError({
                        command: "gh",
                        cwd: input.cwd,
                        cause: null,
                      }),
                    ),
            },
          },
        );
      }),
    );
  });
});
