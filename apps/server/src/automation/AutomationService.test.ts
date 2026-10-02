import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type AutomationConfig,
  type AutomationsSnapshot,
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import {
  OrchestrationV2EventSinkLayerLive,
  OrchestrationV2LayerLive,
} from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import * as AutomationService from "./AutomationService.ts";

const PROJECT_ID = ProjectId.make("automation-project");
const WORKSPACE_ROOT = "/tmp/automation-project";
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const CONFIG: AutomationConfig = {
  name: "Nightly review",
  enabled: true,
  projectId: PROJECT_ID,
  triggers: [{ type: "schedule", cadence: "daily", hour: 3, minute: 0, weekday: 1 }],
  prompt: "Review yesterday's commits.",
  modelSelection,
  runtimeMode: "full-access",
  workingCopy: "local",
  conversation: "fresh",
  deleteThreadWhenDone: true,
  catchUpMinutes: 60,
};

const PlatformLayer = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);
const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-automation-service-",
});

const driver = ProviderDriverKind.make("codex");
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId: modelSelection.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("automation tests never start a provider session"),
  } as ProviderAdapterV2Shape,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

/** The real V2 orchestrator over in-memory SQLite; provider work is never started. */
const OrchestratorLayer = Layer.mergeAll(
  OrchestrationV2LayerLive,
  OrchestrationV2EventSinkLayerLive,
  ProjectStore.layer,
  EffectOutbox.layer,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(
    CheckpointStore.layer.pipe(
      Layer.provide(
        VcsDriverRegistry.layer.pipe(
          Layer.provide(VcsProcess.layer),
          Layer.provide(ServerConfigLayer),
          Layer.provide(PlatformLayer),
        ),
      ),
    ),
  ),
  Layer.provide(ServerConfigLayer),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) =>
        Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
      listInstances: Effect.succeed([providerInstance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(GitWorkflow.GitWorkflowService)({
      pruneWorktrees: () => Effect.void,
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectService.ProjectService)({
      getById: () => Effect.succeed(Option.none()),
    }),
  ),
  Layer.provide(PlatformLayer),
);

/** Runs `beforeDelete` once, just before the first `thread.delete` reaches the orchestrator. */
const interceptDelete = (beforeDelete: Ref.Ref<Effect.Effect<void> | null>) =>
  Layer.effect(
    ThreadManagementService.ThreadManagementService,
    Effect.map(ThreadManagementService.ThreadManagementService, (threads) =>
      ThreadManagementService.ThreadManagementService.of({
        ...threads,
        dispatch: (command) =>
          command.type === "thread.delete"
            ? Ref.getAndSet(beforeDelete, null).pipe(
                Effect.flatMap((hook) => hook ?? Effect.void),
                Effect.andThen(threads.dispatch(command)),
              )
            : threads.dispatch(command),
      }),
    ),
  );

/** Launches like the real service minus workspace preparation: create, then start the message. */
const ThreadLaunchTestLayer = Layer.effect(
  ThreadLaunchService.ThreadLaunchService,
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    return ThreadLaunchService.ThreadLaunchService.of({
      launch: (input) =>
        Effect.gen(function* () {
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
            worktreePath: null,
          });
          yield* threads.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${input.commandId}:initial-message`),
            createdBy: input.createdBy,
            creationSource: input.creationSource,
            threadId,
            messageId: input.initialMessage!.messageId!,
            text: input.initialMessage!.text,
            attachments: [],
            modelSelection: input.modelSelection,
            dispatchMode: { type: "start_immediately" },
          });
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

const makeTestLayer = (input: {
  readonly beforeDelete: Ref.Ref<Effect.Effect<void> | null>;
  readonly summaries: Deferred.Deferred<ReadonlyArray<string>>;
}) => {
  const Threads = interceptDelete(input.beforeDelete).pipe(Layer.provideMerge(OrchestratorLayer));
  return AutomationService.layer.pipe(
    Layer.provideMerge(ThreadLaunchTestLayer),
    Layer.provideMerge(Threads),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getById: (projectId) =>
          Effect.succeed(
            projectId === PROJECT_ID
              ? Option.some({
                  id: PROJECT_ID,
                  title: "Automation project",
                  workspaceRoot: WORKSPACE_ROOT,
                  scripts: [],
                  createdAt: "2026-09-01T00:00:00.000Z",
                  updatedAt: "2026-09-01T00:00:00.000Z",
                  deletedAt: null,
                } as never)
              : Option.none(),
          ),
      }),
    ),
    Layer.provide(Layer.mock(GitWorkflow.GitWorkflowService)({})),
    Layer.provide(Layer.mock(GitHubCli.GitHubCli)({})),
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    ),
    Layer.provide(
      Layer.mock(TextGeneration.TextGeneration)({
        generateRunSummary: (request) =>
          Deferred.succeed(input.summaries, request.agentMessages).pipe(
            Effect.as({ summary: "Generated summary" }),
          ),
      }),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(PlatformLayer),
  );
};

const seedProject = Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
  projects.apply({
    sequence: 0,
    eventId: EventId.make(`seed:${PROJECT_ID}`),
    aggregateKind: "project",
    aggregateId: PROJECT_ID,
    occurredAt: "2026-09-01T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId: PROJECT_ID,
      title: "Automation project",
      workspaceRoot: WORKSPACE_ROOT,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
  }),
);

/** Ends the run the way provider ingestion does: the agent's reply, then the run completing. */
const completeRun = (threadId: ThreadId, reply: string) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const eventSink = yield* EventSink.EventSinkV2;
    const run = ThreadManagementService.latestRun(yield* threads.getThreadProjection(threadId))!;
    const now = yield* DateTime.now;
    yield* eventSink.write({
      commandId: CommandId.make(`complete:${run.id}`),
      events: [
        {
          id: EventId.make(`reply:${run.id}`),
          type: "message.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: {
            createdBy: "agent",
            creationSource: "provider",
            id: MessageId.make(`reply:${run.id}`),
            threadId,
            runId: run.id,
            nodeId: null,
            role: "assistant",
            text: reply,
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make(`completed:${run.id}`),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: {
            ...run,
            status: "completed",
            startedAt: now,
            completedAt: now,
          } satisfies OrchestrationV2Run,
        },
      ],
    });
    return run;
  });

const untilSnapshot = (
  service: AutomationService.AutomationService["Service"],
  predicate: (snapshot: AutomationsSnapshot) => boolean,
) => service.changes.pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));

const withService = <A, E>(
  body: (input: {
    readonly service: AutomationService.AutomationService["Service"];
    readonly beforeDelete: Ref.Ref<Effect.Effect<void> | null>;
    readonly summaries: Deferred.Deferred<ReadonlyArray<string>>;
  }) => Effect.Effect<
    A,
    E,
    ThreadManagementService.ThreadManagementService | EventSink.EventSinkV2
  >,
) =>
  Effect.gen(function* () {
    const beforeDelete = yield* Ref.make<Effect.Effect<void> | null>(null);
    const summaries = yield* Deferred.make<ReadonlyArray<string>>();
    return yield* Effect.gen(function* () {
      yield* seedProject;
      const service = yield* AutomationService.AutomationService;
      yield* service.start();
      return yield* body({ service, beforeDelete, summaries });
    }).pipe(Effect.provide(makeTestLayer({ beforeDelete, summaries })));
  }).pipe(Effect.scoped);

it.effect("deletes a finished run's thread and keeps the agent's summary", () =>
  withService(({ service, summaries }) =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const automation = yield* service.create(CONFIG);
      const run = yield* service.runNow(automation.id);
      assert.strictEqual(run.error, null);
      const threadId = run.threadId!;
      const started = yield* threads.getThreadProjection(threadId);
      assert.strictEqual(started.messages[0]?.text, CONFIG.prompt);

      yield* completeRun(threadId, "Found two regressions.");
      assert.deepStrictEqual(yield* Deferred.await(summaries), ["Found two regressions."]);
      const settled = yield* untilSnapshot(
        service,
        (snapshot) => snapshot.automations[0]?.runs[0]?.summary === "Generated summary",
      );
      assert.isTrue(settled.automations[0]!.runs[0]!.threadDeleted);
      assert.isNotNull((yield* threads.getThreadRecords(threadId, ["runs"])).thread.deletedAt);
    }),
  ),
);

it.effect("keeps the thread when the user writes in it just before the delete lands", () =>
  withService(({ service, beforeDelete, summaries }) =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const automation = yield* service.create(CONFIG);
      const run = yield* service.runNow(automation.id);
      const threadId = run.threadId!;
      const userMessageId = MessageId.make("user-follow-up");
      // Lands after the settle read decided to delete, and before the delete is dispatched.
      yield* Ref.set(
        beforeDelete,
        threads
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("user-follow-up"),
            createdBy: "user",
            creationSource: "web",
            threadId,
            messageId: userMessageId,
            text: "Also check the release notes.",
            attachments: [],
            modelSelection,
            dispatchMode: { type: "start_immediately" },
          })
          .pipe(Effect.orDie, Effect.asVoid),
      );

      yield* completeRun(threadId, "Found two regressions.");
      yield* Deferred.await(summaries);
      const settled = yield* untilSnapshot(
        service,
        (snapshot) => snapshot.automations[0]?.runs[0]?.summary === "Generated summary",
      );
      assert.isUndefined(settled.automations[0]!.runs[0]!.threadDeleted);
      assert.strictEqual(yield* Ref.get(beforeDelete), null);
      const kept = yield* threads.getThreadRecords(threadId, ["messages"]);
      assert.isNull(kept.thread.deletedAt);
      assert.isTrue(kept.messages.some((message) => message.id === userMessageId));
    }),
  ),
);

it.effect("records a failed run instead of failing when the project is gone", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
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
