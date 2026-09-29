import {
  type Automation,
  type AutomationConfig,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderProfileId,
  type ServerProvider,
  type ServerSettings,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../config.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "../orchestration/Services/ThreadDeletionReactor.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { GitHubCli } from "../sourceControl/GitHubCli.ts";
import * as AutomationService from "./AutomationService.ts";

const PROJECT_ID = ProjectId.make("automation-project");

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
  /** Runs after a command is recorded, e.g. to hold one up. */
  readonly afterRecord?: (command: OrchestrationCommand) => Effect.Effect<void>;
}) =>
  AutomationService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            Ref.update(input.commands, (commands) => [...commands, command]).pipe(
              Effect.andThen(input.afterRecord?.(command) ?? Effect.void),
              Effect.as({ sequence: 1 }),
            ),
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () => Effect.succeed(Option.fromNullishOr(input.project)),
          getThreadShellById: () => Effect.succeed(Option.none()),
        }),
        Layer.mock(ThreadDeletionReactor)({ drainThrough: () => Effect.void }),
        Layer.mock(GitWorkflowService)({}),
        Layer.mock(ProjectSetupScriptRunner)({}),
        Layer.mock(GitHubCli)({}),
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
  ) => Effect.Effect<A, E>,
  environment: Pick<Parameters<typeof makeLayer>[0], "settings" | "providers" | "afterRecord"> = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-automations-" });
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

  it.effect("an edit replaces the saved config and reaches subscribers", () =>
    withService(PROJECT, (service) =>
      Effect.gen(function* () {
        const created = yield* service.create(CONFIG);
        const updated = yield* service.update(created.id, {
          ...CONFIG,
          name: "Weekly review",
          prompt: "Review last week's commits.",
        });
        assert.strictEqual(updated.id, created.id);
        assert.strictEqual(updated.prompt, "Review last week's commits.");

        const snapshot = yield* service.changes.pipe(Stream.runHead);
        assert.deepStrictEqual(
          Option.map(snapshot, (value) => value.automations.map((entry) => entry.name)),
          Option.some(["Weekly review"]),
        );
      }),
    ),
  );

  it.effect("idle scheduler ticks stay silent and a due time starts one run", () =>
    withService(PROJECT, (service, { stateDir }) =>
      Effect.gen(function* () {
        // Created at the test clock's epoch; the next run is due five minutes later.
        yield* service.create({
          ...CONFIG,
          triggers: [{ type: "cron", expression: "*/5 * * * *" }],
        });
        const published = yield* service.changes.pipe(
          Stream.takeUntil((snapshot) => snapshot.automations[0]?.runs.length === 1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* service.start();
        yield* TestClock.adjust("5 minutes");

        // Ten idle ticks came first; subscribers only heard the initial list and the run.
        const snapshots = yield* Fiber.join(published);
        assert.deepStrictEqual(
          snapshots.map((snapshot) => snapshot.automations[0]?.runs.length),
          [0, 1],
        );
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.pipe(
          Effect.provide(ServerConfig.layerTest(process.cwd(), stateDir)),
        );
        const onDisk = yield* fs.readFileString(path.join(config.stateDir, "automations.json"));
        assert.include(onDisk, '"scheduleCursor": "1970-01-01T00:05:00.000Z"');
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("a run that is slow to start holds up only its own automation", () =>
    withService(
      PROJECT,
      (service, { commands }) =>
        Effect.gen(function* () {
          const everyMinute = [{ type: "cron" as const, expression: "* * * * *" }];
          yield* service.create({ ...CONFIG, name: "Slow", triggers: everyMinute });
          yield* service.create({ ...CONFIG, name: "Quick", triggers: everyMinute });
          const quickRuns = (snapshot: { automations: ReadonlyArray<Automation> }) =>
            snapshot.automations.find((entry) => entry.name === "Quick")?.runs.length ?? 0;
          yield* service.start();
          // A minute at a time, waiting for each of Quick's runs to be recorded.
          for (const runs of [1, 2, 3]) {
            yield* TestClock.adjust("1 minute");
            yield* service.changes.pipe(
              Stream.filter((snapshot) => quickRuns(snapshot) === runs),
              Stream.runHead,
            );
          }

          // Still creating its first thread, so the later due times did not start it again.
          const slowStarts = (yield* Ref.get(commands)).filter(
            (command) => command.type === "thread.create" && command.title === "Slow",
          );
          assert.strictEqual(slowStarts.length, 1);
        }).pipe(Effect.scoped),
      {
        afterRecord: (command) =>
          command.type === "thread.create" && command.title === "Slow" ? Effect.never : Effect.void,
      },
    ),
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
});
