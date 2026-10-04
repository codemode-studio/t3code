// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import {
  type AutomationConfig,
  type AutomationsSnapshot,
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2Run,
  ProjectId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { makeProviderFailure } from "../orchestration-v2/ProviderFailure.ts";
import { continueRestartedRun } from "../orchestration-v2/RestartContinuation.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  makeOrchestrationV2TestLayer,
  seedProject,
  testModelSelection,
} from "../testUtils/orchestrationV2.ts";
import * as AutomationService from "./AutomationService.ts";

const PROJECT_ID = ProjectId.make("automation-project");
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const WORKSPACE_ROOT = "/tmp/automation-project";

const CONFIG: AutomationConfig = {
  name: "Nightly review",
  enabled: true,
  projectId: PROJECT_ID,
  triggers: [],
  prompt: "Review yesterday's commits.",
  modelSelection: testModelSelection,
  runtimeMode: "full-access",
  workingCopy: "local",
  conversation: "fresh",
  deleteThreadWhenDone: true,
  catchUpMinutes: 60,
};

/** What a test can steer and observe around the service. */
interface Harness {
  /** Runs once, just before the first `thread.delete` reaches the orchestrator. */
  readonly beforeDelete: Ref.Ref<Effect.Effect<void> | null>;
  /** Fails the next launch's workspace preparation with this message. */
  readonly failPreparation: Ref.Ref<string | null>;
  readonly launches: Ref.Ref<ReadonlyArray<ThreadLaunchService.ThreadLaunchInput>>;
  /** The transcript of every summary the service asks for, in order. */
  readonly summaries: Queue.Queue<ReadonlyArray<string>>;
  /** Effect ids the service read from the outbox. */
  readonly outboxReads: Queue.Queue<string>;
  readonly gh: Ref.Ref<(args: ReadonlyArray<string>) => Effect.Effect<string>>;
  readonly worktrees: Ref.Ref<{
    readonly created: ReadonlyArray<string>;
    readonly removed: ReadonlyArray<string>;
  }>;
}

const OrchestratorLayer = makeOrchestrationV2TestLayer("t3-automation-service-");

const interceptDelete = (harness: Harness) =>
  Layer.effect(
    ThreadManagementService.ThreadManagementService,
    Effect.map(ThreadManagementService.ThreadManagementService, (threads) =>
      ThreadManagementService.ThreadManagementService.of({
        ...threads,
        dispatch: (command) =>
          command.type === "thread.delete"
            ? Ref.getAndSet(harness.beforeDelete, null).pipe(
                Effect.flatMap((hook) => hook ?? Effect.void),
                Effect.andThen(threads.dispatch(command)),
              )
            : threads.dispatch(command),
      }),
    ),
  );

/** Launches like the real service, minus workspaces: create, defer the run, then release it. */
const launchTestLayer = (harness: Harness) =>
  Layer.effect(
    ThreadLaunchService.ThreadLaunchService,
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      return ThreadLaunchService.ThreadLaunchService.of({
        retryPreparation: () => Effect.die("Automation tests do not retry workspace preparation"),
        launch: (input) =>
          Effect.gen(function* () {
            yield* Ref.update(harness.launches, (all) => [...all, input]);
            const threadId = ThreadId.make(`thread:${input.commandId}`);
            yield* threads.dispatch({
              type: "thread.create",
              commandId: input.commandId,
              createdBy: input.createdBy,
              creationSource: input.creationSource,
              threadId,
              projectId: input.projectId,
              title: input.title,
              modelSelection: input.modelSelection,
              runtimeMode: input.runtimeMode,
              interactionMode: input.interactionMode,
              branch: null,
              worktreePath:
                input.workspaceStrategy.type === "existing_worktree"
                  ? input.workspaceStrategy.worktreePath
                  : null,
            });
            const dispatched = yield* threads.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`${input.commandId}:initial-message`),
              createdBy: input.createdBy,
              creationSource: input.creationSource,
              threadId,
              messageId: input.initialMessage!.messageId!,
              text: input.initialMessage!.text,
              attachments: [],
              modelSelection: input.modelSelection,
              dispatchMode: { type: "defer_start" },
            });
            const created = dispatched.storedEvents.find(
              (stored) => stored.event.type === "run.created",
            )!.event;
            const runId = created.type === "run.created" ? created.payload.id : undefined!;
            const failure = yield* Ref.getAndSet(harness.failPreparation, null);
            yield* threads.dispatch(
              failure === null
                ? {
                    type: "prepared-run.release",
                    commandId: CommandId.make(`${input.commandId}:release`),
                    threadId,
                    runId,
                  }
                : {
                    type: "prepared-run.fail",
                    commandId: CommandId.make(`${input.commandId}:fail`),
                    threadId,
                    runId,
                    failure: makeProviderFailure({
                      message: failure,
                      class: "validation_error",
                      retryable: false,
                    }),
                  },
            );
            const projection = yield* threads.getThreadProjection(threadId);
            return { threadId, projection, resumed: false };
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ThreadLaunchService.ThreadLaunchError({
                  operation: "create-thread",
                  commandId: input.commandId,
                  projectId: input.projectId,
                  cause,
                }),
            ),
          ),
      });
    }),
  );

const project = {
  id: PROJECT_ID,
  title: "Automation project",
  workspaceRoot: WORKSPACE_ROOT,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  deletedAt: null,
} as never;

/** Everything the service needs around the real orchestrator, shared by every instance a test starts. */
const environmentLayer = (harness: Harness) =>
  launchTestLayer(harness).pipe(
    Layer.provideMerge(interceptDelete(harness)),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          getById: (projectId) =>
            Effect.succeed(projectId === PROJECT_ID ? Option.some(project) : Option.none()),
        }),
        Layer.mock(GitWorkflow.GitWorkflowService)({
          isRepository: () => Effect.succeed(true),
          createWorktree: (input) =>
            Effect.gen(function* () {
              const path = input.path ?? `${WORKSPACE_ROOT}-worktree`;
              yield* Ref.update(harness.worktrees, (all) => ({
                ...all,
                created: [...all.created, path],
              }));
              return { worktree: { path, refName: input.refName } } as never;
            }),
          removeWorktree: (input) =>
            Ref.update(harness.worktrees, (all) => ({
              ...all,
              removed: [...all.removed, input.path],
            })),
        }),
        Layer.mock(GitHubCli.GitHubCli)({
          execute: (input) =>
            Ref.get(harness.gh).pipe(
              Effect.flatMap((respond) => respond(input.args)),
              Effect.map((stdout) => ({ stdout, stderr: "", exitCode: 0 }) as never),
            ),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(TextGeneration.TextGeneration)({
          generateRunSummary: (request) =>
            Queue.offer(harness.summaries, request.agentMessages).pipe(
              Effect.as({ summary: `Summary of: ${request.agentMessages.at(-1)}` }),
            ),
        }),
        ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
      ),
    ),
    Layer.provideMerge(OrchestratorLayer),
  );

/** One server lifetime: the service over the shared environment, started, until `scope` closes. */
const startService = (harness: Harness) =>
  Effect.gen(function* () {
    const outboxReader = Layer.effect(
      EffectOutbox.EffectOutboxV2,
      Effect.map(EffectOutbox.EffectOutboxV2, (outbox) =>
        EffectOutbox.EffectOutboxV2.of({
          ...outbox,
          get: (effectId) =>
            Queue.offer(harness.outboxReads, effectId).pipe(Effect.andThen(outbox.get(effectId))),
        }),
      ),
    );
    const context = yield* Layer.build(AutomationService.layer.pipe(Layer.provide(outboxReader)));
    const service = Context.get(context, AutomationService.AutomationService);
    yield* service.start();
    return service;
  });

type Env = Layer.Success<ReturnType<typeof environmentLayer>>;

const withHarness = <A, E>(body: (harness: Harness) => Effect.Effect<A, E, Env | Scope.Scope>) =>
  Effect.gen(function* () {
    const harness: Harness = {
      beforeDelete: yield* Ref.make<Effect.Effect<void> | null>(null),
      failPreparation: yield* Ref.make<string | null>(null),
      launches: yield* Ref.make<ReadonlyArray<ThreadLaunchService.ThreadLaunchInput>>([]),
      summaries: yield* Queue.unbounded<ReadonlyArray<string>>(),
      outboxReads: yield* Queue.unbounded<string>(),
      gh: yield* Ref.make<(args: ReadonlyArray<string>) => Effect.Effect<string>>(() =>
        Effect.succeed("[]"),
      ),
      worktrees: yield* Ref.make<{
        readonly created: ReadonlyArray<string>;
        readonly removed: ReadonlyArray<string>;
      }>({ created: [], removed: [] }),
    };
    return yield* Effect.gen(function* () {
      yield* seedProject(PROJECT_ID, WORKSPACE_ROOT);
      return yield* body(harness);
    }).pipe(Effect.provide(environmentLayer(harness)));
  }).pipe(Effect.scoped);

const runsOf = (threadId: ThreadId) =>
  Effect.flatMap(ThreadManagementService.ThreadManagementService, (threads) =>
    threads.getThreadRecords(threadId, ["runs"]),
  ).pipe(Effect.map((records) => records.runs));

const write = (events: Parameters<EventSink.EventSinkV2["Service"]["write"]>[0]["events"]) =>
  Effect.flatMap(EventSink.EventSinkV2, (eventSink) => eventSink.write({ events }));

/** The agent's reply in a run, the way provider ingestion records it. */
const reply = (run: OrchestrationV2Run, text: string) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const id = MessageId.make(`reply:${run.id}:${text.length}`);
    yield* write([
      {
        id: EventId.make(`event:${id}`),
        type: "message.updated",
        threadId: run.threadId,
        runId: run.id,
        occurredAt: now,
        payload: {
          createdBy: "agent",
          creationSource: "provider",
          id,
          threadId: run.threadId,
          runId: run.id,
          nodeId: null,
          role: "assistant",
          text,
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      },
    ]);
  });

/** Moves a run to `status`, the way provider ingestion or recovery records it. */
const setStatus = (run: OrchestrationV2Run, status: OrchestrationV2Run["status"]) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    yield* write([
      {
        id: EventId.make(`status:${run.id}:${status}`),
        type: "run.updated",
        threadId: run.threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status, startedAt: now, completedAt: now },
      },
    ]);
  });

const finish = (
  threadId: ThreadId,
  text: string,
  status: OrchestrationV2Run["status"] = "completed",
) =>
  Effect.gen(function* () {
    const run = ThreadManagementService.latestRun({ runs: yield* runsOf(threadId) })!;
    yield* reply(run, text);
    yield* setStatus(run, status);
    return run;
  });

const sendAsUser = (threadId: ThreadId, id: string) =>
  Effect.flatMap(ThreadManagementService.ThreadManagementService, (threads) =>
    threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(id),
      createdBy: "user",
      creationSource: "web",
      threadId,
      messageId: MessageId.make(id),
      text: "Also check the release notes.",
      attachments: [],
      modelSelection: testModelSelection,
      dispatchMode: { type: "start_immediately" },
    }),
  ).pipe(Effect.orDie, Effect.asVoid);

const untilSnapshot = (
  service: AutomationService.AutomationService["Service"],
  predicate: (snapshot: AutomationsSnapshot) => boolean,
) => service.changes.pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));

const firstRun = (snapshot: AutomationsSnapshot) => snapshot.automations[0]?.runs[0];
const isDeleted = (threadId: ThreadId) =>
  Effect.flatMap(ThreadManagementService.ThreadManagementService, (threads) =>
    threads.getThreadShell(threadId),
  ).pipe(Effect.map((shell) => shell === null));

it.effect("deletes a finished run's thread and keeps the agent's summary", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const service = yield* startService(harness);
      const automation = yield* service.create(CONFIG);
      const run = yield* service.runNow(automation.id);
      assert.strictEqual(run.error, null);
      const threadId = run.threadId!;

      yield* finish(threadId, "Found two regressions.");
      assert.deepStrictEqual(yield* Queue.take(harness.summaries), ["Found two regressions."]);
      const settled = yield* untilSnapshot(
        service,
        (snapshot) => firstRun(snapshot)?.summary === "Summary of: Found two regressions.",
      );
      assert.isTrue(firstRun(settled)!.threadDeleted);
      assert.isTrue(yield* isDeleted(threadId));
    }),
  ),
);

it.effect("keeps the thread when the user writes in it just before the delete lands", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const service = yield* startService(harness);
      const automation = yield* service.create(CONFIG);
      const threadId = (yield* service.runNow(automation.id)).threadId!;
      // Lands after the settle read decided to delete, and before the delete is dispatched.
      const threads = yield* ThreadManagementService.ThreadManagementService;
      yield* Ref.set(
        harness.beforeDelete,
        sendAsUser(threadId, "user-follow-up").pipe(
          Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
        ),
      );

      yield* finish(threadId, "Found two regressions.");
      yield* Queue.take(harness.summaries);
      yield* service.drain;
      assert.strictEqual(yield* Ref.get(harness.beforeDelete), null);
      const snapshot = yield* untilSnapshot(service, (s) => firstRun(s)?.summary !== undefined);
      assert.isUndefined(firstRun(snapshot)!.threadDeleted);
      assert.isFalse(yield* isDeleted(threadId));
    }),
  ),
);

it.effect("records a failed run instead of failing when the project is gone", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const service = yield* startService(harness);
      const automation = yield* service.create({
        ...CONFIG,
        projectId: ProjectId.make("missing-project"),
      });
      const run = yield* service.runNow(automation.id);
      assert.strictEqual(run.threadId, null);
      assert.strictEqual(run.error, "The automation's project no longer exists.");
    }),
  ),
);

it.effect("keeps failed, interrupted and cancelled runs with their own summary and failure", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const service = yield* startService(harness);
      for (const status of ["interrupted", "cancelled"] as const) {
        const automation = yield* service.create({ ...CONFIG, name: status });
        const threadId = (yield* service.runNow(automation.id)).threadId!;
        yield* finish(threadId, `Stopped while ${status}.`, status);
        assert.deepStrictEqual(yield* Queue.take(harness.summaries), [`Stopped while ${status}.`]);
        yield* service.drain;
        assert.isFalse(yield* isDeleted(threadId));
      }

      // Workspace preparation fails after the launch returned: the run records why.
      yield* Ref.set(harness.failPreparation, "Setup script exited with 1.");
      const failing = yield* service.create({ ...CONFIG, name: "failing" });
      const run = yield* service.runNow(failing.id);
      assert.strictEqual(run.error, null);
      const snapshot = yield* untilSnapshot(service, (s) =>
        s.automations.some(
          (automation) =>
            automation.name === "failing" &&
            automation.runs[0]?.error === "Setup script exited with 1.",
        ),
      );
      const failed = snapshot.automations.find((automation) => automation.name === "failing")!;
      assert.isUndefined(failed.runs[0]!.threadDeleted);
      assert.isFalse(yield* isDeleted(run.threadId!));
    }),
  ),
);

it.effect("waits on a request the run left open, then settles when it is answered", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const service = yield* startService(harness);
      const automation = yield* service.create(CONFIG);
      const threadId = (yield* service.runNow(automation.id)).threadId!;
      const run = ThreadManagementService.latestRun({ runs: yield* runsOf(threadId) })!;
      const now = yield* DateTime.now;
      const request = {
        id: RuntimeRequestId.make("automation-question"),
        nodeId: run.rootNodeId!,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input" as const,
        status: "pending" as const,
        responseCapability: { type: "message" as const },
        createdAt: now,
        resolvedAt: null,
      };
      const requestEvent = (status: "pending" | "resolved") => ({
        id: EventId.make(`automation-question:${status}`),
        type: "runtime-request.updated" as const,
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...request, status, resolvedAt: status === "pending" ? null : now },
      });
      // An async question that outlives the provider turn.
      yield* write([requestEvent("pending")]);
      yield* finish(threadId, "Asked which branch to use.");
      yield* service.drain;
      assert.strictEqual(yield* Queue.size(harness.summaries), 0);

      yield* write([requestEvent("resolved")]);
      assert.deepStrictEqual(yield* Queue.take(harness.summaries), ["Asked which branch to use."]);
      yield* untilSnapshot(service, (snapshot) => firstRun(snapshot)?.threadDeleted === true);
    }),
  ),
);

it.effect("settles when the provider's background task roster clears, with no other event", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const service = yield* startService(harness);
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const automation = yield* service.create(CONFIG);
      const threadId = (yield* service.runNow(automation.id)).threadId!;
      const providerThread = (yield* threads.getThreadProjection(threadId)).providerThreads[0]!;
      const roster = (tasks: ReadonlyArray<{ readonly taskId: string }>) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          yield* write([
            {
              id: EventId.make(`roster:${tasks.length}`),
              type: "provider-thread.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...providerThread,
                pendingBackgroundTasks: tasks.map((task) => ({
                  ...task,
                  kind: "background_task" as const,
                })),
                updatedAt: now,
              },
            },
          ]);
        });
      yield* roster([{ taskId: "long-build" }]);
      yield* finish(threadId, "Started the long build.");
      yield* service.drain;
      assert.strictEqual(yield* Queue.size(harness.summaries), 0);

      // Only the roster clearing; no run, turn item or other event follows.
      yield* roster([]);
      assert.deepStrictEqual(yield* Queue.take(harness.summaries), ["Started the long build."]);
      yield* untilSnapshot(service, (snapshot) => firstRun(snapshot)?.threadDeleted === true);
    }),
  ),
);

it.effect("keeps the thread when the agent wakes in a later run for the work it left", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const service = yield* startService(harness);
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const automation = yield* service.create(CONFIG);
      const threadId = (yield* service.runNow(automation.id)).threadId!;
      const providerThread = (yield* threads.getThreadProjection(threadId)).providerThreads[0]!;
      const roster = (tasks: ReadonlyArray<{ readonly taskId: string }>) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          yield* write([
            {
              id: EventId.make(`wake-roster:${tasks.length}`),
              type: "provider-thread.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...providerThread,
                pendingBackgroundTasks: tasks.map((task) => ({
                  ...task,
                  kind: "background_task" as const,
                })),
                updatedAt: now,
              },
            },
          ]);
        });
      yield* roster([{ taskId: "long-build" }]);
      const automationRun = yield* finish(threadId, "Started the long build.");

      // The background task ends: provider continuation wakes the agent the way upstream does,
      // with an agent-created notification queued after any active run.
      const wakeId = MessageId.make("background-wake");
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("provider-continuation:background-wake"),
        threadId,
        messageId: wakeId,
        text: "Background activity updated",
        notification: {
          source: { kind: "background_task" },
          outcome: "updated",
          summary: "Background activity updated",
        },
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "provider",
      });
      yield* roster([]);
      yield* service.drain;

      // The automation's own run settled: summarized from its own reply only.
      assert.deepStrictEqual(yield* Queue.take(harness.summaries), ["Started the long build."]);
      yield* service.drain;
      const wake = (yield* runsOf(threadId)).find((run) => run.userMessageId === wakeId)!;
      assert.isTrue(wake.ordinal > automationRun.ordinal);
      assert.isTrue(ThreadManagementService.isActiveRun(wake) || wake.status === "queued");
      assert.isFalse(yield* isDeleted(threadId));
      const snapshot = yield* untilSnapshot(service, (s) => firstRun(s)?.summary !== undefined);
      assert.isUndefined(firstRun(snapshot)!.threadDeleted);
    }),
  ),
);

it.effect("continues one thread, one run at a time, each with its own summary", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const service = yield* startService(harness);
      const automation = yield* service.create({
        ...CONFIG,
        conversation: "continue",
        deleteThreadWhenDone: false,
      });
      const first = yield* service.runNow(automation.id);
      const blocked = yield* service.runNow(automation.id);
      assert.strictEqual(
        blocked.error,
        "The previous run is still going or waiting for you in the same thread.",
      );
      yield* finish(first.threadId!, "First pass.");
      assert.deepStrictEqual(yield* Queue.take(harness.summaries), ["First pass."]);
      yield* service.drain;

      const second = yield* service.runNow(automation.id);
      assert.strictEqual(second.error, null);
      assert.strictEqual(second.threadId, first.threadId);
      yield* finish(first.threadId!, "Second pass.");
      // Only the second run's reply, not the first run's, though both share the thread.
      assert.deepStrictEqual(yield* Queue.take(harness.summaries), ["Second pass."]);
      yield* service.drain;
      assert.strictEqual((yield* Ref.get(harness.launches)).length, 1);
      assert.isFalse(yield* isDeleted(first.threadId!));
    }),
  ),
);

it.effect("turning delete-when-done off spares the thread of a run still going", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const service = yield* startService(harness);
      const automation = yield* service.create(CONFIG);
      const threadId = (yield* service.runNow(automation.id)).threadId!;
      const { id: _id, createdAt: _c, updatedAt: _u, runs: _r, ...config } = automation;
      yield* service.update(automation.id, { ...config, deleteThreadWhenDone: false });
      yield* finish(threadId, "Done.");
      yield* Queue.take(harness.summaries);
      yield* service.drain;
      assert.isFalse(yield* isDeleted(threadId));
    }),
  ),
);

it.effect("persists automations and settles runs that ended while the server was down", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const threadId = yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* startService(harness);
          const automation = yield* service.create(CONFIG);
          return (yield* service.runNow(automation.id)).threadId!;
        }),
      );
      // The run ends while no automation service is listening.
      yield* finish(threadId, "Finished overnight.");

      const restarted = yield* startService(harness);
      assert.deepStrictEqual(yield* Queue.take(harness.summaries), ["Finished overnight."]);
      const snapshot = yield* untilSnapshot(restarted, (s) => firstRun(s)?.threadDeleted === true);
      assert.strictEqual(snapshot.automations[0]!.name, CONFIG.name);
      assert.isTrue(yield* isDeleted(threadId));
    }),
  ),
);

it.effect("binds runs saved before V2 only to the run their message started", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const { owned, foreign, oldest } = yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* startService(harness);
          const automation = yield* service.create({ ...CONFIG, deleteThreadWhenDone: false });
          const owned = (yield* service.runNow(automation.id)).threadId!;
          const foreign = (yield* service.runNow(automation.id)).threadId!;
          const oldest = (yield* service.runNow(automation.id)).threadId!;
          return { owned, foreign, oldest };
        }),
      );
      // Rewrite the pending runs the way the V1 build saved them: no V2 run id; the foreign
      // entry's message was never imported as a run, and the oldest kept no message at all.
      const filePath = NodePath.join(config.stateDir, "automations.json");
      const file = decodeJson(NodeFS.readFileSync(filePath, "utf8")) as {
        readonly automations: ReadonlyArray<{
          readonly pendingRuns: Array<Record<string, unknown>>;
        }>;
      };
      for (const entry of file.automations[0]!.pendingRuns) {
        delete entry.orchestrationRunId;
        if (entry.threadId === foreign) entry.messageId = "v1-message-without-a-run";
        if (entry.threadId === oldest) delete entry.messageId;
      }
      NodeFS.writeFileSync(filePath, encodeJson(file));
      yield* finish(owned, "Automation reply.");
      // In the other two threads the latest run is the user's, after the automation's.
      for (const threadId of [foreign, oldest]) {
        yield* finish(threadId, "Automation reply.");
        yield* sendAsUser(threadId, `user:${threadId}`);
        yield* finish(threadId, "Reply to the user.");
      }

      const restarted = yield* startService(harness);
      assert.deepStrictEqual(yield* Queue.take(harness.summaries), ["Automation reply."]);
      yield* restarted.drain;
      assert.strictEqual(yield* Queue.size(harness.summaries), 0);
      const runs = (yield* untilSnapshot(restarted, () => true)).automations[0]!.runs;
      const byThread = (threadId: ThreadId) => runs.find((run) => run.threadId === threadId)!;
      assert.strictEqual(byThread(owned).summary, "Summary of: Automation reply.");
      // Ownership cannot be shown: kept, and never summarized from the user's run.
      assert.isUndefined(byThread(foreign).summary);
      assert.isUndefined(byThread(oldest).summary);
      for (const threadId of [owned, foreign, oldest]) {
        assert.isNotNull(yield* threads.getThreadShell(threadId));
      }
    }),
  ),
);

it.effect("follows a restart continuation that recovery owes but has not dispatched yet", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* startService(harness);
          const automation = yield* service.create(CONFIG);
          return (yield* service.runNow(automation.id)).threadId!;
        }),
      );
      const source = ThreadManagementService.latestRun({ runs: yield* runsOf(threadId) })!;
      yield* reply(source, "Halfway through.");

      // Startup recovery: the run is cancelled and the continuation recorded as a durable intent,
      // in one write, before any continuation message or run exists.
      const now = yield* DateTime.now;
      const effectId = `effect:restart-continuation:${source.id}`;
      yield* eventSink.writeWithEffects({
        commandId: CommandId.make(`command:restart-recovery:${source.id}`),
        events: [
          {
            id: EventId.make(`recovery:${source.id}`),
            type: "run.updated",
            threadId,
            runId: source.id,
            occurredAt: now,
            payload: { ...source, status: "cancelled", completedAt: now },
          },
        ],
        effects: [
          {
            id: effectId,
            commandId: CommandId.make(`command:restart-recovery:${source.id}`),
            threadId,
            request: { type: "provider-runtime.continue", sourceRunId: source.id },
          },
        ],
      });

      // The automation service starts and rechecks before the effect worker continues the run.
      const service = yield* startService(harness);
      assert.strictEqual(yield* Queue.take(harness.outboxReads), effectId);
      yield* service.drain;
      assert.strictEqual(yield* Queue.size(harness.summaries), 0);
      assert.isFalse(yield* isDeleted(threadId));

      // The effect worker dispatches the continuation, which the agent finishes.
      yield* continueRestartedRun({ threadId, sourceRunId: source.id });
      const continuation = (yield* runsOf(threadId)).find(
        (run) => run.restartContinuationOfRunId === source.id,
      )!;
      yield* reply(continuation, "Finished after the restart.");
      yield* setStatus(continuation, "completed");

      // Both runs are the automation's: the continuation's agent-sent message is not the user
      // writing, and the summary reads the whole chain.
      assert.deepStrictEqual(yield* Queue.take(harness.summaries), [
        "Halfway through.",
        "Finished after the restart.",
      ]);
      yield* untilSnapshot(service, (snapshot) => firstRun(snapshot)?.threadDeleted === true);
      assert.isTrue(yield* isDeleted(threadId));
    }),
  ),
);

it.effect("settles a cancelled run once recovery skips the continuation it intended", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const service = yield* startService(harness);
      const automation = yield* service.create(CONFIG);
      const threadId = (yield* service.runNow(automation.id)).threadId!;
      const source = ThreadManagementService.latestRun({ runs: yield* runsOf(threadId) })!;
      const startEffect = Option.getOrThrow(
        yield* outbox.claimNext({ workerId: "test-worker", leaseDurationMs: 60_000 }),
      );
      assert.strictEqual(startEffect.request.type, "provider-turn.start");
      yield* outbox.succeed({ effectId: startEffect.id, workerId: "test-worker" });
      yield* reply(source, "Halfway through.");
      const now = yield* DateTime.now;
      const effectId = `effect:restart-continuation:${source.id}`;
      yield* eventSink.writeWithEffects({
        commandId: CommandId.make(`command:restart-recovery:${source.id}`),
        events: [
          {
            id: EventId.make(`recovery:${source.id}`),
            type: "run.updated",
            threadId,
            runId: source.id,
            occurredAt: now,
            payload: { ...source, status: "cancelled", completedAt: now },
          },
        ],
        effects: [
          {
            id: effectId,
            commandId: CommandId.make(`command:restart-recovery:${source.id}`),
            threadId,
            request: { type: "provider-runtime.continue", sourceRunId: source.id },
          },
        ],
      });
      yield* service.drain;
      assert.strictEqual(yield* Queue.size(harness.summaries), 0);

      // The worker runs the intent and finds nothing to continue: no thread event follows.
      const claimed = yield* outbox.claimNext({ workerId: "test-worker", leaseDurationMs: 60_000 });
      assert.strictEqual(Option.getOrThrow(claimed).id, effectId);
      yield* outbox.succeed({ effectId, workerId: "test-worker" });
      yield* TestClock.adjust("30 seconds");
      assert.deepStrictEqual(yield* Queue.take(harness.summaries), ["Halfway through."]);
      yield* service.drain;
      assert.isFalse(yield* isDeleted(threadId));
    }),
  ),
);

it.effect("starts one run per due schedule time", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const service = yield* startService(harness);
      yield* service.create({
        ...CONFIG,
        triggers: [{ type: "cron", expression: "* * * * *" }],
      });
      yield* TestClock.adjust("60 seconds");
      const first = yield* untilSnapshot(service, (s) => s.automations[0]!.runs.length === 1);
      assert.match(first.automations[0]!.runs[0]!.cause, /minute/i);
      yield* TestClock.adjust("60 seconds");
      const second = yield* untilSnapshot(service, (s) => s.automations[0]!.runs.length >= 2);
      assert.strictEqual(second.automations[0]!.runs.length, 2);
      assert.strictEqual((yield* Ref.get(harness.launches)).length, 2);
    }),
  ),
);

/**
 * Saves `config` with GitHub already watched since the epoch, as a server that has polled before
 * would have it, so the next service's first tick lists pull requests right away.
 */
const createWatching = (harness: Harness, config: AutomationConfig) =>
  Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.flatMap(startService(harness), (service) => service.create(config)),
    );
    const serverConfig = yield* ServerConfig.ServerConfig;
    const filePath = NodePath.join(serverConfig.stateDir, "automations.json");
    const file = decodeJson(NodeFS.readFileSync(filePath, "utf8")) as {
      readonly automations: Array<Record<string, unknown>>;
    };
    file.automations[0]!.githubCursor = "1970-01-01T00:00:00.000Z";
    NodeFS.writeFileSync(filePath, encodeJson(file));
  });

const pullRequestList = encodeJson([
  {
    number: 12,
    title: "Add retries",
    url: "https://github.com/acme/app/pull/12",
    createdAt: "1970-01-01T00:01:00.000Z",
    isDraft: false,
  },
]);

it.effect("reviews a new pull request detached at its head and links the thread", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      yield* Ref.set(harness.gh, (args) =>
        Effect.succeed(args[0] === "pr" && args[1] === "list" ? pullRequestList : ""),
      );
      yield* createWatching(harness, {
        ...CONFIG,
        workingCopy: "worktree",
        deleteThreadWhenDone: false,
        triggers: [{ type: "github", event: "pull_request.opened" }],
      });
      const service = yield* startService(harness);
      const snapshot = yield* untilSnapshot(service, (s) => s.automations[0]!.runs.length === 1);
      const run = snapshot.automations[0]!.runs[0]!;
      assert.strictEqual(run.error, null);
      assert.match(run.cause, /#12/);
      const [launch] = yield* Ref.get(harness.launches);
      const created = (yield* Ref.get(harness.worktrees)).created;
      assert.deepStrictEqual(launch!.workspaceStrategy, {
        type: "existing_worktree",
        worktreePath: created[0]!,
      });
      assert.include(launch!.initialMessage!.text, "gh pr checkout 12 --detach");
      const thread = (yield* threads.getThreadRecords(run.threadId!, [])).thread;
      assert.deepStrictEqual(
        (thread.pullRequests ?? []).map((link) => link.number),
        [12],
      );
    }),
  ),
);

it.effect("removes the pull request worktree and records the failure when checkout fails", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* Ref.set(harness.gh, (args) =>
        args[0] === "pr" && args[1] === "list"
          ? Effect.succeed(pullRequestList)
          : Effect.die(new Error("Pull request checkout failed.")),
      );
      yield* createWatching(harness, {
        ...CONFIG,
        workingCopy: "worktree",
        triggers: [{ type: "github", event: "pull_request.opened" }],
      });
      const service = yield* startService(harness);
      const snapshot = yield* untilSnapshot(service, (s) => s.automations[0]!.runs.length === 1);
      assert.strictEqual(snapshot.automations[0]!.runs[0]!.error, "Pull request checkout failed.");
      const worktrees = yield* Ref.get(harness.worktrees);
      assert.deepStrictEqual(worktrees.removed, worktrees.created);
      assert.strictEqual((yield* Ref.get(harness.launches)).length, 0);
    }),
  ),
);

it.effect("handles each pull request of one poll against the automation as it now is", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const item = (number: number) => ({
        number,
        title: `Change ${number}`,
        url: `https://github.com/acme/app/pull/${number}`,
        createdAt: `1970-01-01T00:0${number - 10}:00.000Z`,
        isDraft: false,
      });
      yield* Ref.set(harness.gh, (args) =>
        Effect.succeed(args[1] === "list" ? encodeJson([item(11), item(12)]) : ""),
      );
      yield* createWatching(harness, {
        ...CONFIG,
        conversation: "continue",
        deleteThreadWhenDone: false,
        triggers: [{ type: "github", event: "pull_request.opened" }],
      });
      const service = yield* startService(harness);
      const snapshot = yield* untilSnapshot(service, (s) => s.automations[0]!.runs.length === 2);
      const [second, first] = snapshot.automations[0]!.runs;
      assert.strictEqual(first!.error, null);
      // The second item sees the thread the first one started, and waits its turn there
      // instead of starting a thread of its own.
      assert.strictEqual(
        second!.error,
        "The previous run is still going or waiting for you in the same thread.",
      );
      assert.strictEqual((yield* Ref.get(harness.launches)).length, 1);
    }),
  ),
);
