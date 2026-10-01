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
    readonly deliveredMessages?: ReadonlyArray<MessageId>;
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
    const delivered = new Set(options.deliveredMessages ?? []);

    const layer = DelegationService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(OrchestrationEngineService)({
            dispatch: (command) =>
              Effect.gen(function* () {
                if (command.type === "thread.create") {
                  yield* setThread(shell(command.threadId, null, { title: command.title }));
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
                      messages: [
                        {
                          id: MessageId.make("final"),
                          role: "assistant",
                          text: "Found two bugs.",
                          turnId: TurnId.make("turn-1"),
                          streaming: false,
                          createdAt: AT,
                          updatedAt: AT,
                        },
                      ],
                      proposedPlans: [],
                      activities: [],
                      checkpoints: [],
                    })),
                  ),
                ),
              ),
            listActivitiesByKind: () => Effect.succeed(options.startedActivities ?? []),
            getTurnStartMessage: ({ messageId }) =>
              Effect.succeed(
                delivered.has(messageId)
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

  it.effect("a delegated thread cannot delegate further", () =>
    withService(({ service }) =>
      Effect.gen(function* () {
        const { threadId: child } = yield* service.delegate({
          parentThreadId: PARENT_ID,
          provider: "codex",
          prompt: "Review.",
        });
        const error = yield* service
          .delegate({ parentThreadId: child, provider: "codex", prompt: "Review again." })
          .pipe(Effect.flip);
        assert.include(error.message, "cannot delegate further");
      }),
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
        deliveredMessages: [MessageId.make(`delegation:${reported}`)],
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
      DelegationService.delegatedThreadStatus(shell(id, null, { session: session(id, "error") })),
      "failed",
    );
  });
});
