import {
  type AutomationConfig,
  ProjectId,
  ProviderInstanceId,
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
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "../orchestration/Services/ThreadDeletionReactor.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
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
        Layer.mock(GitWorkflowService)({}),
        Layer.mock(ProjectSetupScriptRunner)({}),
        Layer.mock(GitHubCli)({}),
        ServerSettingsService.layerTest(),
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
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-automations-" });
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const service = yield* AutomationService.AutomationService.pipe(
      Effect.provide(makeLayer({ stateDir, commands, project })),
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
});
