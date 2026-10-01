import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationSession,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type ServerProvider,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import * as DelegationService from "./DelegationService.ts";

const PROJECT_ID = ProjectId.make("delegation-project");
const PARENT_ID = ThreadId.make("parent-thread");
const AT = "2026-09-01T00:00:00.000Z";

const CODEX = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex",
  enabled: true,
  installed: true,
  status: "ready",
  models: [
    { slug: "gpt-5", name: "GPT-5", isCustom: false, isDefault: true },
    { slug: "gpt-5-mini", name: "GPT-5 mini", isCustom: false },
  ],
} as unknown as ServerProvider;

const session = (
  threadId: ThreadId,
  status: OrchestrationSession["status"],
): OrchestrationSession => ({
  threadId,
  status,
  providerName: "codex",
  runtimeMode: "full-access",
  activeTurnId: status === "running" ? TurnId.make("turn-1") : null,
  lastError: null,
  updatedAt: AT,
});

const shell = (
  id: ThreadId,
  latestTurn: OrchestrationLatestTurn["state"] | null,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => ({
  id,
  projectId: PROJECT_ID,
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" },
  runtimeMode: "full-access",
  interactionMode: "default",
  pullRequests: [],
  branch: "feature",
  worktreePath: "/tmp/worktree",
  latestTurn:
    latestTurn === null
      ? null
      : {
          turnId: TurnId.make("turn-1"),
          state: latestTurn,
          requestedAt: AT,
          startedAt: AT,
          completedAt: latestTurn === "running" ? null : AT,
          assistantMessageId: MessageId.make("final"),
        },
  createdAt: AT,
  updatedAt: AT,
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

const sessionSet = (threadId: ThreadId): OrchestrationEvent => ({
  sequence: 2,
  eventId: EventId.make(`event-${threadId}`),
  aggregateKind: "thread",
  aggregateId: threadId,
  occurredAt: AT,
  commandId: CommandId.make(`command-${threadId}`),
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "thread.session-set",
  payload: { threadId, session: session(threadId, "ready") },
});

const assistantMessage = (id: string, text: string): OrchestrationMessage => ({
  id: MessageId.make(id),
  role: "assistant",
  text,
  turnId: TurnId.make("turn-1"),
  streaming: false,
  createdAt: AT,
  updatedAt: AT,
});

interface Harness {
  readonly service: DelegationService.DelegationService["Service"];
  readonly setThread: (thread: OrchestrationThreadShell) => Effect.Effect<void>;
  readonly publish: (event: OrchestrationEvent) => Effect.Effect<void>;
  /** The next dispatched command, in order. */
  readonly nextCommand: Effect.Effect<OrchestrationCommand>;
  readonly pendingCommands: Effect.Effect<number>;
}

const withService = <A, E>(
  body: (harness: Harness) => Effect.Effect<A, E, Scope.Scope>,
  options: {
    readonly threads?: ReadonlyArray<OrchestrationThreadShell>;
    readonly startedActivities?: ReadonlyArray<OrchestrationThreadActivity>;
    /** User messages already in the projection, as thread and message id. */
    readonly userMessages?: ReadonlyArray<readonly [ThreadId, MessageId]>;
    /** What every thread's detail holds; one final answer by default. */
    readonly messages?: ReadonlyArray<OrchestrationMessage>;
  } = {},
) =>
  Effect.gen(function* () {
    const threads = yield* Ref.make<ReadonlyMap<ThreadId, OrchestrationThreadShell>>(
      new Map(
        (
          options.threads ?? [
            shell(PARENT_ID, "running", { session: session(PARENT_ID, "running") }),
          ]
        ).map((thread) => [thread.id, thread]),
      ),
    );
    const commands = yield* Queue.unbounded<OrchestrationCommand>();
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    const subscribed = yield* Deferred.make<void>();
    const setThread = (thread: OrchestrationThreadShell) =>
      Ref.update(threads, (current) => new Map(current).set(thread.id, thread));
    const userMessages = new Set(
      (options.userMessages ?? []).map(([threadId, messageId]) => `${threadId}/${messageId}`),
    );

    const layer = DelegationService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(OrchestrationEngineService)({
            dispatch: (command) =>
              Effect.gen(function* () {
                if (command.type === "thread.create") {
                  yield* setThread(
                    shell(command.threadId, null, {
                      title: command.title,
                      parentThreadId: command.parentThreadId ?? null,
                    }),
                  );
                }
                if (command.type === "thread.turn.start") {
                  userMessages.add(`${command.threadId}/${command.message.messageId}`);
                }
                yield* Queue.offer(commands, command);
                return { sequence: 1 };
              }),
            streamDomainEvents: Stream.unwrap(
              PubSub.subscribe(events).pipe(
                Effect.tap(() => Deferred.succeed(subscribed, undefined)),
                Effect.map(Stream.fromSubscription),
              ),
            ),
          }),
          Layer.mock(ProjectionSnapshotQuery)({
            getThreadShellById: (threadId) =>
              Ref.get(threads).pipe(Effect.map((all) => Option.fromNullishOr(all.get(threadId)))),
            getThreadDetailById: (threadId) =>
              Ref.get(threads).pipe(
                Effect.map((all) =>
                  Option.fromNullishOr(all.get(threadId)).pipe(
                    Option.map((thread): OrchestrationThread => ({
                      ...thread,
                      deletedAt: null,
                      messages: options.messages ?? [assistantMessage("final", "Found two bugs.")],
                      proposedPlans: [],
                      activities: [],
                      checkpoints: [],
                    })),
                  ),
                ),
              ),
            listActivitiesByKind: () => Effect.succeed(options.startedActivities ?? []),
            getTurnStartMessage: ({ threadId, messageId }) =>
              Effect.succeed(
                userMessages.has(`${threadId}/${messageId}`)
                  ? Option.some({
                      message: {
                        id: messageId,
                        role: "user" as const,
                        text: "",
                        turnId: null,
                        streaming: false,
                        createdAt: AT,
                        updatedAt: AT,
                      },
                      hasOtherUserMessages: true,
                    })
                  : Option.none(),
              ),
          }),
          Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([CODEX]) }),
        ),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    const service = Context.get(yield* Layer.build(layer), DelegationService.DelegationService);
    yield* service.start();
    yield* Deferred.await(subscribed);
    return yield* body({
      service,
      setThread,
      publish: (event) => PubSub.publish(events, event).pipe(Effect.asVoid),
      nextCommand: Queue.take(commands),
      pendingCommands: Queue.size(commands),
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("DelegationService", () => {
  it.effect("runs the task as a thread in the caller's working copy and lists it as an agent", () =>
    withService(({ service, nextCommand }) =>
      Effect.gen(function* () {
        const result = yield* service.delegate({
          parentThreadId: PARENT_ID,
          provider: "codex",
          prompt: "Review the uncommitted changes.",
          title: "Review changes",
        });
        assert.strictEqual(result.model, "gpt-5");

        const create = yield* nextCommand;
        assert(create.type === "thread.create");
        assert.strictEqual(create.threadId, result.threadId);
        assert.strictEqual(create.parentThreadId, PARENT_ID);
        assert.strictEqual(create.worktreePath, "/tmp/worktree");
        assert.strictEqual(create.branch, "feature");
        assert.deepStrictEqual(create.modelSelection, {
          instanceId: CODEX.instanceId,
          model: "gpt-5",
        });

        const turn = yield* nextCommand;
        assert(turn.type === "thread.turn.start");
        assert.strictEqual(turn.threadId, result.threadId);
        assert.include(turn.message.text, "Review the uncommitted changes.");

        const started = yield* nextCommand;
        assert(started.type === "thread.activity.append");
        assert.strictEqual(started.threadId, PARENT_ID);
        assert.strictEqual(started.activity.kind, "task.started");
        assert.deepInclude(started.activity.payload as object, {
          taskId: result.threadId,
          title: "Review changes",
          role: "Codex",
          agentKind: "agent",
          delegatedThreadId: result.threadId,
        });
      }),
    ),
  );

  it.effect("reports the result back once the caller's turn has ended", () =>
    withService(({ service, setThread, publish, nextCommand, pendingCommands }) =>
      Effect.gen(function* () {
        const { threadId: child } = yield* service.delegate({
          parentThreadId: PARENT_ID,
          provider: "Codex",
          prompt: "Review the uncommitted changes.",
          title: "Review changes",
        });
        for (let i = 0; i < 3; i++) yield* nextCommand;

        yield* setThread(shell(child, "completed", { session: session(child, "ready") }));
        yield* publish(sessionSet(child));
        const completed = yield* nextCommand;
        assert(completed.type === "thread.activity.append");
        assert.strictEqual(completed.threadId, PARENT_ID);
        assert.strictEqual(completed.activity.kind, "task.completed");
        assert.deepInclude(completed.activity.payload as object, {
          taskId: child,
          status: "completed",
          summary: "Found two bugs.",
        });

        // The caller is still mid-turn, so the result waits.
        yield* service.drain;
        assert.strictEqual(yield* pendingCommands, 0);

        yield* setThread(shell(PARENT_ID, "completed", { session: session(PARENT_ID, "ready") }));
        yield* publish(sessionSet(PARENT_ID));
        const result = yield* nextCommand;
        assert(result.type === "thread.turn.start");
        assert.strictEqual(result.threadId, PARENT_ID);
        assert.strictEqual(result.message.messageId, MessageId.make(`delegation:${child}`));
        assert.include(result.message.text, 'Codex finished the delegated task "Review changes".');
        assert.include(result.message.text, "Found two bugs.");
      }),
    ),
  );

  it.effect("a delegated thread cannot delegate further, even after its task finished", () =>
    withService(({ service, setThread, publish, nextCommand }) =>
      Effect.gen(function* () {
        const { threadId: child } = yield* service.delegate({
          parentThreadId: PARENT_ID,
          provider: "codex",
          prompt: "Review.",
        });
        for (let i = 0; i < 3; i++) yield* nextCommand;
        const nested = service
          .delegate({ parentThreadId: child, provider: "codex", prompt: "Review again." })
          .pipe(Effect.flip);
        assert.include((yield* nested).message, "cannot delegate further");

        // Finished and reported, then continued by the user.
        yield* setThread(
          shell(child, "completed", {
            session: session(child, "ready"),
            parentThreadId: PARENT_ID,
          }),
        );
        yield* publish(sessionSet(child));
        yield* nextCommand;
        assert.include((yield* nested).message, "cannot delegate further");
      }),
    ),
  );

  // Its messages are gone too, as after a rewind to the start.
  it.effect("a delegated thread cannot delegate after a restart or a rewind", () => {
    const child = ThreadId.make("reported-child");
    return withService(
      ({ service }) =>
        Effect.gen(function* () {
          const error = yield* service
            .delegate({ parentThreadId: child, provider: "codex", prompt: "Review again." })
            .pipe(Effect.flip);
          assert.include(error.message, "cannot delegate further");
        }),
      {
        threads: [
          shell(PARENT_ID, "completed", { session: session(PARENT_ID, "ready") }),
          shell(child, "completed", {
            session: session(child, "ready"),
            parentThreadId: PARENT_ID,
          }),
        ],
        userMessages: [[PARENT_ID, MessageId.make(`delegation:${child}`)]],
        messages: [],
      },
    );
  });

  const settleChild = (
    service: Harness["service"],
    harness: Pick<Harness, "setThread" | "publish" | "nextCommand">,
    latestTurn: OrchestrationLatestTurn["state"],
    childSession: OrchestrationSession["status"],
    lastError: string | null = null,
  ) =>
    Effect.gen(function* () {
      const { threadId: child } = yield* service.delegate({
        parentThreadId: PARENT_ID,
        provider: "codex",
        prompt: "Review.",
        title: "Review changes",
      });
      for (let i = 0; i < 3; i++) yield* harness.nextCommand;
      yield* harness.setThread(
        shell(child, latestTurn, { session: { ...session(child, childSession), lastError } }),
      );
      yield* harness.publish(sessionSet(child));
      yield* harness.nextCommand;
      const result = yield* harness.nextCommand;
      assert(result.type === "thread.turn.start");
      return result.message.text;
    });

  it.effect("reports the turn's last message even when the turn points at earlier commentary", () =>
    withService(
      ({ service, ...harness }) =>
        Effect.gen(function* () {
          const text = yield* settleChild(service, harness, "completed", "ready");
          assert.include(text, "Found two bugs.");
          assert.notInclude(text, "Looking at the diff.");
        }),
      {
        threads: [shell(PARENT_ID, "completed", { session: session(PARENT_ID, "ready") })],
        // The shell's turn points at "final"; here that id is the commentary.
        messages: [
          assistantMessage("final", "Looking at the diff."),
          assistantMessage("answer", "Found two bugs."),
        ],
      },
    ),
  );

  it.effect("a failed task reports its partial message with the error", () =>
    withService(
      ({ service, ...harness }) =>
        Effect.gen(function* () {
          const text = yield* settleChild(
            service,
            harness,
            "error",
            "error",
            "Usage limit reached.",
          );
          assert.include(text, 'Codex could not finish the delegated task "Review changes".');
          assert.include(text, "Found two bugs.");
          assert.include(text, "Error: Usage limit reached.");
        }),
      { threads: [shell(PARENT_ID, "completed", { session: session(PARENT_ID, "ready") })] },
    ),
  );

  it.effect("reports a task stopped before its turn started", () =>
    withService(
      ({ service, setThread, publish, nextCommand }) =>
        Effect.gen(function* () {
          const { threadId: child } = yield* service.delegate({
            parentThreadId: PARENT_ID,
            provider: "codex",
            prompt: "Review.",
            title: "Review changes",
          });
          for (let i = 0; i < 3; i++) yield* nextCommand;

          yield* setThread(shell(child, null, { session: session(child, "stopped") }));
          yield* publish(sessionSet(child));
          const completed = yield* nextCommand;
          assert(completed.type === "thread.activity.append");
          assert.deepInclude(completed.activity.payload as object, {
            taskId: child,
            status: "stopped",
          });
          const result = yield* nextCommand;
          assert(result.type === "thread.turn.start");
          assert.strictEqual(result.threadId, PARENT_ID);
          assert.include(
            result.message.text,
            'Codex was stopped before finishing the delegated task "Review changes".',
          );
        }),
      { threads: [shell(PARENT_ID, "completed", { session: session(PARENT_ID, "ready") })] },
    ),
  );

  it.effect("names the available providers when none matches", () =>
    withService(({ service }) =>
      Effect.gen(function* () {
        const error = yield* service
          .delegate({ parentThreadId: PARENT_ID, provider: "gemini", prompt: "Review." })
          .pipe(Effect.flip);
        assert.include(error.message, "codex (Codex)");
      }),
    ),
  );

  const startedActivity = (child: ThreadId): OrchestrationThreadActivity => ({
    id: EventId.make(`delegation:${child}:started`),
    tone: "info",
    kind: "task.started",
    summary: "Delegated task started",
    payload: {
      taskId: child,
      title: "Review changes",
      role: "Codex",
      delegatedThreadId: child,
      parentThreadId: PARENT_ID,
    },
    turnId: null,
    createdAt: AT,
  });

  it.effect("after a restart, reports back a delegation that finished unreported", () => {
    const finished = ThreadId.make("finished-child");
    const reported = ThreadId.make("reported-child");
    return withService(
      ({ nextCommand, service, pendingCommands }) =>
        Effect.gen(function* () {
          const completed = yield* nextCommand;
          assert(completed.type === "thread.activity.append");
          assert.strictEqual(
            completed.activity.id,
            EventId.make(`delegation:${finished}:completed`),
          );
          const result = yield* nextCommand;
          assert(result.type === "thread.turn.start");
          assert.strictEqual(result.message.messageId, MessageId.make(`delegation:${finished}`));
          yield* service.drain;
          assert.strictEqual(yield* pendingCommands, 0);
        }),
      {
        threads: [
          shell(PARENT_ID, "completed", { session: session(PARENT_ID, "ready") }),
          shell(finished, "interrupted", { session: session(finished, "stopped") }),
          shell(reported, "completed", { session: session(reported, "ready") }),
        ],
        startedActivities: [startedActivity(finished), startedActivity(reported)],
        userMessages: [[PARENT_ID, MessageId.make(`delegation:${reported}`)]],
      },
    );
  });

  /** A delegated thread whose turn requested at `at` has finished. */
  const finishedSince = (id: ThreadId, at: string): OrchestrationThreadShell => {
    const finished = shell(id, "completed", {
      session: { ...session(id, "ready"), updatedAt: at },
      parentThreadId: PARENT_ID,
    });
    return { ...finished, latestTurn: { ...finished.latestTurn!, requestedAt: at } };
  };
  const idleParent = shell(PARENT_ID, "completed", { session: session(PARENT_ID, "ready") });

  it.effect("sends a follow-up to the same thread and reports that round back too", () =>
    withService(
      ({ service, setThread, publish, nextCommand, pendingCommands }) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse("2026-09-02T00:00:00.000Z"));
          const { threadId: child } = yield* service.delegate({
            parentThreadId: PARENT_ID,
            provider: "codex",
            prompt: "Review.",
            title: "Review changes",
          });
          for (let i = 0; i < 3; i++) yield* nextCommand;
          yield* setThread(finishedSince(child, AT));
          yield* publish(sessionSet(child));
          yield* nextCommand;
          const first = yield* nextCommand;
          assert(first.type === "thread.turn.start");
          assert.include(first.message.text, `threadId "${child}"`);

          yield* TestClock.setTime(Date.parse("2026-09-03T00:00:00.000Z"));
          const again = yield* service.delegate({
            parentThreadId: PARENT_ID,
            threadId: child,
            prompt: "Fixed both bugs. Please re-review.",
          });
          assert.strictEqual(again.threadId, child);
          const followUp = yield* nextCommand;
          assert(followUp.type === "thread.turn.start");
          assert.strictEqual(followUp.threadId, child);
          assert.include(followUp.message.text, "Please re-review.");
          const round = followUp.message.messageId;
          const started = yield* nextCommand;
          assert(started.type === "thread.activity.append");
          assert.strictEqual(started.activity.kind, "task.started");
          assert.deepInclude(started.activity.payload as object, {
            taskId: child,
            followUp: round,
          });
          const resumed = yield* nextCommand;
          assert(resumed.type === "thread.activity.append");
          assert.deepInclude(resumed.activity.payload as object, {
            taskId: child,
            status: "running",
          });

          // The first round's finished turn is still the latest one: nothing reports yet.
          yield* publish(sessionSet(child));
          yield* service.drain;
          assert.strictEqual(yield* pendingCommands, 0);

          yield* setThread(finishedSince(child, "2026-09-03T00:00:00.000Z"));
          yield* publish(sessionSet(child));
          const completed = yield* nextCommand;
          assert(completed.type === "thread.activity.append");
          assert.strictEqual(
            completed.activity.id,
            EventId.make(`delegation:${child}:${round}:completed`),
          );
          const result = yield* nextCommand;
          assert(result.type === "thread.turn.start");
          assert.strictEqual(result.threadId, PARENT_ID);
          assert.strictEqual(
            result.message.messageId,
            MessageId.make(`delegation:${child}:${round}`),
          );
        }),
      { threads: [idleParent] },
    ),
  );

  it.effect("refuses follow-ups to threads it did not delegate or that are not ready", () => {
    const stranger = ThreadId.make("stranger");
    const busy = ThreadId.make("busy-child");
    return withService(
      ({ service, nextCommand }) =>
        Effect.gen(function* () {
          const followUp = (threadId: ThreadId) =>
            service.delegate({ parentThreadId: PARENT_ID, threadId, prompt: "Again." }).pipe(
              Effect.flip,
              Effect.map((error) => error.message),
            );
          assert.include(yield* followUp(stranger), "is not a task this thread delegated");
          // The user is talking to it directly.
          assert.include(yield* followUp(busy), "busy");

          const { threadId: working } = yield* service.delegate({
            parentThreadId: PARENT_ID,
            provider: "codex",
            prompt: "Review.",
          });
          for (let i = 0; i < 3; i++) yield* nextCommand;
          assert.include(yield* followUp(working), "has not reported back");
        }),
      {
        threads: [
          idleParent,
          shell(stranger, "completed", { session: session(stranger, "ready") }),
          shell(busy, "running", {
            session: session(busy, "running"),
            parentThreadId: PARENT_ID,
          }),
        ],
      },
    );
  });

  it.effect("after a restart, reports back a follow-up that finished unreported", () => {
    const child = ThreadId.make("followed-up-child");
    const round = MessageId.make("round-2");
    const requestedAt = "2026-09-02T00:00:00.000Z";
    return withService(
      ({ nextCommand }) =>
        Effect.gen(function* () {
          const completed = yield* nextCommand;
          assert(completed.type === "thread.activity.append");
          assert.strictEqual(
            completed.activity.id,
            EventId.make(`delegation:${child}:${round}:completed`),
          );
          const result = yield* nextCommand;
          assert(result.type === "thread.turn.start");
          assert.strictEqual(
            result.message.messageId,
            MessageId.make(`delegation:${child}:${round}`),
          );
        }),
      {
        threads: [idleParent, finishedSince(child, requestedAt)],
        startedActivities: [
          startedActivity(child),
          {
            ...startedActivity(child),
            id: EventId.make(`delegation:${child}:${round}:started`),
            payload: {
              ...(startedActivity(child).payload as object),
              followUp: round,
              requestedAt,
            },
          },
        ],
        // The first round already reported back.
        userMessages: [[PARENT_ID, MessageId.make(`delegation:${child}`)]],
      },
    );
  });
});

describe("delegatedThreadStatus", () => {
  it("waits while the turn runs and maps how it ended", () => {
    const id = ThreadId.make("child");
    assert.strictEqual(DelegationService.delegatedThreadStatus(shell(id, null)), null);
    assert.strictEqual(
      DelegationService.delegatedThreadStatus(
        shell(id, "running", { session: session(id, "running") }),
      ),
      null,
    );
    assert.strictEqual(
      DelegationService.delegatedThreadStatus(shell(id, "interrupted")),
      "stopped",
    );
    assert.strictEqual(
      DelegationService.delegatedThreadStatus(shell(id, null, { session: session(id, "stopped") })),
      "stopped",
    );
    assert.strictEqual(
      DelegationService.delegatedThreadStatus(shell(id, null, { session: session(id, "error") })),
      "failed",
    );
  });

  it("for a follow-up, ignores the turn and session state from before it", () => {
    const id = ThreadId.make("child");
    const since = "2026-09-02T00:00:00.000Z";
    const later = "2026-09-02T00:00:05.000Z";
    const previous = shell(id, "completed", { session: session(id, "ready") });
    assert.strictEqual(DelegationService.delegatedThreadStatus(previous, since), null);
    assert.strictEqual(
      DelegationService.delegatedThreadStatus(
        { ...previous, latestTurn: { ...previous.latestTurn!, requestedAt: later } },
        since,
      ),
      "completed",
    );
    // Failed before its own turn could start.
    assert.strictEqual(
      DelegationService.delegatedThreadStatus(
        { ...previous, session: { ...session(id, "error"), updatedAt: later } },
        since,
      ),
      "failed",
    );
  });
});
