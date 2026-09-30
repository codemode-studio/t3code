import {
  type Automation,
  AUTOMATION_MAX_RUNS,
  type AutomationConfig,
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderProfileId,
  type ServerProvider,
  type ServerSettings,
  type VcsCreateWorktreeInput,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationLatestTurn,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../config.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
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
  deleteThreadWhenDone: false,
  catchUpMinutes: 60,
};

const threadShell = (
  id: ThreadId,
  latestTurn: OrchestrationLatestTurn["state"] | null,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => ({
  id,
  projectId: PROJECT_ID,
  title: "Nightly review",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  pullRequests: [],
  branch: null,
  worktreePath: null,
  latestTurn:
    latestTurn === null
      ? null
      : {
          turnId: TurnId.make("turn-1"),
          state: latestTurn,
          requestedAt: "2026-09-01T00:00:00.000Z",
          startedAt: "2026-09-01T00:00:00.000Z",
          completedAt: latestTurn === "running" ? null : "2026-09-01T00:01:00.000Z",
          assistantMessageId: null,
        },
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});

const threadEventBase = (threadId: ThreadId) => ({
  sequence: 2,
  eventId: EventId.make(`event-${threadId}`),
  aggregateKind: "thread" as const,
  aggregateId: threadId,
  occurredAt: "2026-09-01T00:01:00.000Z",
  commandId: CommandId.make(`command-${threadId}`),
  causationEventId: null,
  correlationId: null,
  metadata: {},
});

/** A background task finishing, which can come after the turn and its checkpoint. */
const taskCompleted = (threadId: ThreadId): OrchestrationEvent => ({
  ...threadEventBase(threadId),
  type: "thread.activity-appended",
  payload: {
    threadId,
    activity: {
      id: EventId.make(`task-${threadId}`),
      tone: "info",
      kind: "task.completed",
      summary: "Task completed",
      payload: {},
      turnId: null,
      createdAt: "2026-09-01T00:02:00.000Z",
    },
  },
});

/** The session settling, which is what tells cleanup to look at the thread again. */
const sessionSettled = (threadId: ThreadId): OrchestrationEvent => ({
  ...threadEventBase(threadId),
  type: "thread.session-set",
  payload: {
    threadId,
    session: {
      threadId,
      status: "ready",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-09-01T00:01:00.000Z",
    },
  },
});

const makeLayer = (input: {
  readonly stateDir: string;
  readonly commands: Ref.Ref<ReadonlyArray<OrchestrationCommand>>;
  readonly project: OrchestrationProjectShell | null;
  readonly settings?: Parameters<typeof ServerSettingsService.layerTest>[0];
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly git?: Partial<GitWorkflowService["Service"]>;
  readonly gitHubCli?: Partial<GitHubCli["Service"]>;
  /** Runs after a command is recorded, e.g. to hold one up or reject it. */
  readonly afterRecord?: (
    command: OrchestrationCommand,
  ) => Effect.Effect<void, OrchestrationCommandInvariantError>;
  /** Thread shells the projection returns; missing ids read as deleted. */
  readonly threads?: Ref.Ref<ReadonlyMap<ThreadId, OrchestrationThreadShell>>;
  readonly events?: PubSub.PubSub<OrchestrationEvent>;
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
          streamDomainEvents: input.events ? Stream.fromPubSub(input.events) : Stream.never,
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () => Effect.succeed(Option.fromNullishOr(input.project)),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
          getThreadShellById: (threadId) =>
            input.threads
              ? Ref.get(input.threads).pipe(
                  Effect.map((threads) => Option.fromNullishOr(threads.get(threadId))),
                )
              : Effect.succeedNone,
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
  }: Pick<
    Parameters<typeof makeLayer>[0],
    "settings" | "providers" | "git" | "gitHubCli" | "afterRecord" | "threads" | "events"
  > & {
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
        // Clients show schedule times in the zone the server evaluates them in.
        assert.deepStrictEqual(
          Option.map(snapshot, (value) => value.timeZone),
          Option.some(Intl.DateTimeFormat().resolvedOptions().timeZone),
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
      }).pipe(Effect.provide(NodeServices.layer)),
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
        }),
      {
        afterRecord: (command) =>
          command.type === "thread.create" && command.title === "Slow" ? Effect.never : Effect.void,
      },
    ),
  );

  it.effect(
    "a GitHub poll that lands on a scheduled run's tick waits for the next free tick",
    () => {
      // Already watching GitHub, and due every minute, so every two-minute poll lands on a tick
      // where a scheduled run is starting.
      const epoch = "1970-01-01T00:00:00.000Z";
      const pullRequest = {
        number: 7,
        title: "Add a thing",
        url: "https://github.com/acme/repo/pull/7",
        createdAt: "1970-01-01T00:01:30.000Z",
        isDraft: false,
      };
      const causes = (snapshot: { automations: ReadonlyArray<Automation> }) =>
        snapshot.automations[0]?.runs.map((run) => run.cause).toReversed() ?? [];
      return withService(
        PROJECT,
        (service) =>
          Effect.gen(function* () {
            yield* service.start();
            for (const [step, runs] of [
              ["1 minute", 1],
              ["1 minute", 2],
              ["30 seconds", 3],
            ] as const) {
              yield* TestClock.adjust(step);
              yield* service.changes.pipe(
                Stream.filter((snapshot) => causes(snapshot).length === runs),
                Stream.runHead,
              );
            }

            const snapshot = yield* service.changes.pipe(Stream.runHead);
            assert.deepStrictEqual(
              Option.map(snapshot, causes),
              Option.some(["Every minute", "Every minute", "Pull request opened: #7"]),
            );
          }),
        {
          automationsFile: {
            automations: [
              {
                ...CONFIG,
                triggers: [
                  { type: "cron", expression: "* * * * *" },
                  { type: "github", event: "pull_request.opened" },
                ],
                id: "mixed",
                createdAt: epoch,
                updatedAt: epoch,
                runs: [],
                scheduleCursor: epoch,
                githubCursor: epoch,
              },
            ],
          },
          gitHubCli: {
            // Lists the pull request once it has been opened.
            execute: () =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((nowMs) =>
                  encodeJson(Date.parse(pullRequest.createdAt) <= nowMs ? [pullRequest] : []),
                ),
                Effect.orDie,
                Effect.map((stdout) => ({
                  exitCode: ChildProcessSpawner.ExitCode(0),
                  stdout,
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                })),
              ),
          },
        },
      );
    },
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

  describe("deleting a run's thread when done", () => {
    const isDeleted = (snapshot: { automations: ReadonlyArray<Automation> }, threadId: ThreadId) =>
      snapshot.automations[0]?.runs.some((run) => run.threadId === threadId && run.threadDeleted) ??
      false;

    /**
     * A service with cleanup started, whose projection starts each new thread without a turn.
     * The cleanup worker checks threads in order, so once a later thread is deleted every
     * earlier check has been decided.
     */
    const withCleanup = <A, E>(
      body: (context: {
        readonly service: AutomationService.AutomationService["Service"];
        readonly automationId: string;
        readonly setThread: (thread: OrchestrationThreadShell) => Effect.Effect<void>;
        readonly publish: (event: OrchestrationEvent) => Effect.Effect<void>;
        readonly deletes: Effect.Effect<ReadonlyArray<ThreadId>>;
        readonly waitDeleted: (threadId: ThreadId) => Effect.Effect<void>;
      }) => Effect.Effect<A, E, Scope.Scope>,
      options: {
        readonly threads?: ReadonlyArray<OrchestrationThreadShell>;
        readonly automationsFile?: unknown;
        /** Runs when a delete is dispatched; fail to reject it like the engine guard would. */
        readonly onDelete?: (
          threadId: ThreadId,
          projection: {
            readonly setThread: (thread: OrchestrationThreadShell) => Effect.Effect<void>;
            readonly publish: (event: OrchestrationEvent) => Effect.Effect<void>;
          },
        ) => Effect.Effect<void, OrchestrationCommandInvariantError>;
      } = {},
    ) =>
      Effect.gen(function* () {
        const threads = yield* Ref.make<ReadonlyMap<ThreadId, OrchestrationThreadShell>>(
          new Map((options.threads ?? []).map((thread) => [thread.id, thread])),
        );
        const events = yield* PubSub.unbounded<OrchestrationEvent>();
        const setThread = (thread: OrchestrationThreadShell) =>
          Ref.update(threads, (current) => new Map(current).set(thread.id, thread));
        const publish = (event: OrchestrationEvent) =>
          PubSub.publish(events, event).pipe(Effect.asVoid);
        return yield* withService(
          PROJECT,
          (service, { commands }) =>
            Effect.gen(function* () {
              const automationId =
                options.automationsFile === undefined
                  ? (yield* service.create({ ...CONFIG, deleteThreadWhenDone: true })).id
                  : "offline";
              yield* service.start();
              return yield* body({
                service,
                automationId,
                setThread,
                publish,
                deletes: Ref.get(commands).pipe(
                  Effect.map((all) =>
                    all.flatMap((command) =>
                      command.type === "thread.auto-delete" ? [command.threadId] : [],
                    ),
                  ),
                ),
                waitDeleted: (threadId) =>
                  service.changes.pipe(
                    Stream.filter((snapshot) => isDeleted(snapshot, threadId)),
                    Stream.runHead,
                    Effect.asVoid,
                  ),
              });
            }),
          {
            threads,
            events,
            ...(options.automationsFile === undefined
              ? {}
              : { automationsFile: options.automationsFile }),
            afterRecord: (command) =>
              command.type === "thread.create"
                ? setThread(threadShell(command.threadId, null))
                : command.type === "thread.auto-delete"
                  ? (options.onDelete?.(command.threadId, { setThread, publish }) ?? Effect.void)
                  : Effect.void,
          },
        );
      });

    it.effect("deletes the thread once its turn completes and keeps one that errored", () =>
      withCleanup(({ service, automationId, setThread, publish, deletes, waitDeleted }) =>
        Effect.gen(function* () {
          const failed = (yield* service.runNow(automationId)).threadId!;
          const finished = (yield* service.runNow(automationId)).threadId!;
          yield* setThread(threadShell(failed, "error"));
          yield* publish(sessionSettled(failed));
          yield* setThread(threadShell(finished, "completed"));
          yield* publish(sessionSettled(finished));
          yield* waitDeleted(finished);
          assert.deepStrictEqual(yield* deletes, [finished]);

          // The errored thread was let go, so a later completion does not delete it either.
          const sentinel = (yield* service.runNow(automationId)).threadId!;
          yield* setThread(threadShell(failed, "completed"));
          yield* publish(sessionSettled(failed));
          yield* setThread(threadShell(sentinel, "completed"));
          yield* publish(sessionSettled(sentinel));
          yield* waitDeleted(sentinel);
          assert.deepStrictEqual(yield* deletes, [finished, sentinel]);
        }),
      ),
    );

    it.effect("keeps a thread the user wrote in after the engine rejects a stale delete", () =>
      Effect.gen(function* () {
        const rejected = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
        yield* withCleanup(
          ({ service, automationId, setThread, publish, deletes, waitDeleted }) =>
            Effect.gen(function* () {
              const adopted = (yield* service.runNow(automationId)).threadId!;
              const sentinel = (yield* service.runNow(automationId)).threadId!;
              yield* setThread(threadShell(adopted, "completed"));
              yield* publish(sessionSettled(adopted));
              yield* setThread(threadShell(sentinel, "completed"));
              yield* publish(sessionSettled(sentinel));
              yield* waitDeleted(sentinel);
              assert.deepStrictEqual(yield* Ref.get(rejected), [adopted]);

              // The user's turn finishing later still leaves the thread alone.
              const laterSentinel = (yield* service.runNow(automationId)).threadId!;
              yield* setThread(
                threadShell(adopted, "completed", {
                  latestUserMessageAt: "2026-09-01T00:03:00.000Z",
                }),
              );
              yield* publish(sessionSettled(adopted));
              yield* setThread(threadShell(laterSentinel, "completed"));
              yield* publish(sessionSettled(laterSentinel));
              yield* waitDeleted(laterSentinel);
              assert.deepStrictEqual(yield* deletes, [adopted, sentinel, laterSentinel]);
            }),
          {
            // The user's message lands after cleanup read the thread and before the engine
            // decides the delete, so the engine rejects it and the message queues another check.
            onDelete: (threadId, { setThread, publish }) =>
              Effect.gen(function* () {
                if ((yield* Ref.get(rejected)).length > 0) return;
                yield* Ref.set(rejected, [threadId]);
                yield* setThread(
                  threadShell(threadId, "running", {
                    latestUserMessageAt: "2026-09-01T00:03:00.000Z",
                    session: {
                      threadId,
                      status: "running",
                      providerName: "codex",
                      runtimeMode: "full-access",
                      activeTurnId: TurnId.make("turn-2"),
                      lastError: null,
                      updatedAt: "2026-09-01T00:03:00.000Z",
                    },
                  }),
                );
                yield* publish(sessionSettled(threadId));
                return yield* new OrchestrationCommandInvariantError({
                  commandType: "thread.auto-delete",
                  detail: "thread changed before automatic deletion",
                });
              }),
          },
        );
      }),
    );

    it.effect("rechecks when a background task outlasting the turn finishes", () =>
      withCleanup(({ service, automationId, setThread, publish, deletes, waitDeleted }) =>
        Effect.gen(function* () {
          const threadId = (yield* service.runNow(automationId)).threadId!;
          const sentinel = (yield* service.runNow(automationId)).threadId!;
          // The turn and its checkpoint are done, but a subagent is still working.
          yield* setThread(threadShell(threadId, "completed", { backgroundLiveness: "working" }));
          yield* publish(sessionSettled(threadId));
          yield* setThread(threadShell(sentinel, "completed"));
          yield* publish(sessionSettled(sentinel));
          yield* waitDeleted(sentinel);
          assert.deepStrictEqual(yield* deletes, [sentinel]);

          // Finishing the task emits only an activity, no session or checkpoint event.
          yield* setThread(threadShell(threadId, "completed"));
          yield* publish(taskCompleted(threadId));
          yield* waitDeleted(threadId);
          assert.deepStrictEqual(yield* deletes, [sentinel, threadId]);
        }),
      ),
    );

    it.effect("still deletes a thread whose run fell out of the run history", () =>
      Effect.gen(function* () {
        const deleted = yield* Deferred.make<ThreadId>();
        yield* withCleanup(
          ({ service, automationId, setThread, publish }) =>
            Effect.gen(function* () {
              const oldest = (yield* service.runNow(automationId)).threadId!;
              for (let index = 0; index < AUTOMATION_MAX_RUNS; index++) {
                yield* service.runNow(automationId);
              }
              const snapshot = yield* service.changes.pipe(Stream.runHead);
              assert.isFalse(
                Option.getOrThrow(snapshot).automations[0]!.runs.some(
                  (run) => run.threadId === oldest,
                ),
              );
              yield* setThread(threadShell(oldest, "completed"));
              yield* publish(sessionSettled(oldest));
              assert.strictEqual(yield* Deferred.await(deleted), oldest);
            }),
          { onDelete: (threadId) => Deferred.succeed(deleted, threadId).pipe(Effect.asVoid) },
        );
      }),
    );

    it.effect("finishes cleanup for turns that completed while the server was down", () => {
      const threadId = ThreadId.make("finished-offline");
      return withCleanup(
        ({ deletes, waitDeleted }) =>
          Effect.gen(function* () {
            yield* waitDeleted(threadId);
            assert.deepStrictEqual(yield* deletes, [threadId]);
          }),
        {
          threads: [threadShell(threadId, "completed")],
          automationsFile: {
            automations: [
              {
                ...CONFIG,
                deleteThreadWhenDone: true,
                id: "offline",
                createdAt: "2026-09-01T00:00:00.000Z",
                updatedAt: "2026-09-01T00:00:00.000Z",
                scheduleCursor: "2026-09-01T00:00:00.000Z",
                githubCursor: null,
                pendingThreadDeletes: [{ threadId, messageAt: "2026-09-01T00:00:00.000Z" }],
                runs: [
                  {
                    id: "run-1",
                    startedAt: "2026-09-01T00:00:00.000Z",
                    cause: "Manual run",
                    threadId,
                    error: null,
                  },
                ],
              },
            ],
          },
        },
      );
    });
  });

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
