/**
 * Lets an agent hand a task to another provider through the `t3-code` MCP
 * server. The task runs as its own thread in the caller's working copy, the
 * caller's Agents panel tracks it as a subagent, and its final message comes
 * back to the caller's thread as a new message once that thread is idle.
 *
 * Nothing is stored outside the event log. The parent's `task.started` row
 * names the child thread, and the result message has an id derived from the
 * child, so after a restart the service finds every delegation that has not
 * reported back yet and resumes watching it.
 *
 * @module DelegationService
 */
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  isProviderAvailable,
  MessageId,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { resolveProviderProfileFallbackModelSelection } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { threadHasQueuedTurnStart } from "../orchestration/ThreadSettlementPolicy.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";

/** Long enough for a full review; past it the caller is pointed at the child thread. */
const MAX_RESULT_CHARS = 40_000;
const MAX_TITLE_CHARS = 80;

const CHILD_PROMPT_FOOTER =
  "This task was delegated to you by another agent working in this project, in the same working copy. When you finish, your final message is sent back to that agent as the result, so make it complete and self-contained.";

export class DelegationError extends Schema.TaggedError<DelegationError>()("DelegationError", {
  message: Schema.String,
}) {}

export interface DelegateInput {
  readonly parentThreadId: ThreadId;
  /** A provider instance id, driver kind, or display name, such as "codex". */
  readonly provider: string;
  readonly prompt: string;
  readonly title?: string | undefined;
  readonly model?: string | undefined;
}

export interface DelegateResult {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly provider: ProviderInstanceId;
  readonly model: string;
}

export class DelegationService extends Context.Service<
  DelegationService,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly delegate: (input: DelegateInput) => Effect.Effect<DelegateResult, DelegationError>;
    /** Resolves once every queued check has run; for tests. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/delegation/DelegationService") {}

interface Delegation {
  readonly childThreadId: ThreadId;
  readonly parentThreadId: ThreadId;
  readonly title: string;
  readonly providerName: string;
}

type DelegationStatus = "completed" | "failed" | "stopped";

interface Outcome {
  readonly delegation: Delegation;
  readonly status: DelegationStatus;
  /** The child's final message, or why it has none. */
  readonly text: string;
}

const startedActivityId = (child: ThreadId) => EventId.make(`delegation:${child}:started`);
const completedActivityId = (child: ThreadId) => EventId.make(`delegation:${child}:completed`);
const resultMessageId = (child: ThreadId) => MessageId.make(`delegation:${child}`);
/** Tags the command that creates a delegated thread; its creation event keeps it for good. */
const CREATE_COMMAND_TAG = "delegation-thread-create";

/** How a delegated thread stands; `null` while its turn has not finished. */
export function delegatedThreadStatus(
  thread: Pick<OrchestrationThreadShell, "latestTurn" | "session">,
): DelegationStatus | null {
  if (thread.session?.status === "starting" || thread.session?.status === "running") return null;
  switch (thread.latestTurn?.state) {
    case "completed":
      return "completed";
    case "error":
      return "failed";
    case "interrupted":
      return "stopped";
    case "running":
      return null;
    default:
      // No turn yet: still starting, unless the session failed or stopped before it could.
      switch (thread.session?.status) {
        case "error":
          return "failed";
        case "stopped":
        case "interrupted":
          return "stopped";
        default:
          return null;
      }
  }
}

/** Whether a message can start a new turn on the parent without steering or blocking one. */
function parentCanReceive(thread: OrchestrationThreadShell, now: string): boolean {
  return !(
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    threadHasQueuedTurnStart(thread, now)
  );
}

function resultMessageText(outcome: Outcome): string {
  const { delegation, status } = outcome;
  const heading =
    status === "completed"
      ? `${delegation.providerName} finished the delegated task "${delegation.title}".`
      : status === "failed"
        ? `${delegation.providerName} could not finish the delegated task "${delegation.title}".`
        : `${delegation.providerName} was stopped before finishing the delegated task "${delegation.title}".`;
  const body =
    outcome.text.length > MAX_RESULT_CHARS
      ? `${outcome.text.slice(0, MAX_RESULT_CHARS)}\n\n[Truncated. The full result is in the thread "${delegation.title}".]`
      : outcome.text;
  return `${heading}\n\n${body}`;
}

const titleFrom = (input: DelegateInput) => {
  const source = input.title?.trim() || input.prompt.trim().split("\n")[0]!.trim();
  return source.length > MAX_TITLE_CHARS ? `${source.slice(0, MAX_TITLE_CHARS - 1)}…` : source;
};

/** Matches an instance id first, then a driver kind or display name, preferring ready instances. */
function findProvider(
  providers: ReadonlyArray<ServerProvider>,
  query: string,
): ServerProvider | undefined {
  const wanted = query.trim().toLowerCase();
  const usable = providers.filter((provider) => provider.enabled && isProviderAvailable(provider));
  const exact = usable.find((provider) => provider.instanceId.toLowerCase() === wanted);
  if (exact) return exact;
  const matches = usable.filter(
    (provider) =>
      provider.driver.toLowerCase() === wanted || provider.displayName?.toLowerCase() === wanted,
  );
  return matches.find((provider) => provider.status === "ready") ?? matches[0];
}

const providerLabel = (provider: ServerProvider) => provider.displayName ?? provider.driver;

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)),
    );
  const failWith = (message: string) => Effect.fail(new DelegationError({ message }));

  /** Delegations whose child is still working, by child thread. */
  const running = new Map<ThreadId, Delegation>();
  /** Finished delegations waiting for their parent to be free, by parent thread. */
  const undelivered = new Map<ThreadId, Array<Outcome>>();

  const appendParentActivity = (
    parentThreadId: ThreadId,
    activity: Omit<OrchestrationThreadActivity, "createdAt" | "turnId">,
  ) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: yield* commandId("delegation-activity"),
        threadId: parentThreadId,
        activity: { ...activity, turnId: null, createdAt },
        createdAt,
      });
    });

  const finalMessageOf = (childThreadId: ThreadId, status: DelegationStatus) =>
    Effect.gen(function* () {
      const thread = yield* snapshots.getThreadDetailById(childThreadId);
      if (Option.isNone(thread)) return "The delegated thread no longer exists.";
      const assistant = thread.value.messages.filter((message) => message.role === "assistant");
      const turnId = thread.value.latestTurn?.turnId;
      // The turn's last message, not its message pointer: a checkpoint captured before the
      // answer landed can leave the pointer on earlier commentary.
      const final = assistant.findLast((message) => message.turnId === turnId) ?? assistant.at(-1);
      const text = final?.text.trim();
      if (status !== "failed") return text || "It produced no final message.";
      const error = thread.value.session?.lastError ?? "The provider reported an error.";
      return text ? `${text}\n\nError: ${error}` : error;
    });

  const deliver = Effect.fn("DelegationService.deliver")(function* (parentThreadId: ThreadId) {
    const outcomes = undelivered.get(parentThreadId);
    if (!outcomes || outcomes.length === 0) return;
    const parent = yield* snapshots.getThreadShellById(parentThreadId);
    if (Option.isNone(parent) || parent.value.archivedAt !== null) {
      // Nobody is left to read it; the child thread still holds the result.
      undelivered.delete(parentThreadId);
      return;
    }
    if (!parentCanReceive(parent.value, yield* nowIso)) return;
    const outcome = outcomes[0]!;
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: yield* commandId("delegation-result"),
      threadId: parentThreadId,
      message: {
        messageId: resultMessageId(outcome.delegation.childThreadId),
        role: "user",
        text: resultMessageText(outcome),
        attachments: [],
      },
      runtimeMode: parent.value.runtimeMode,
      interactionMode: parent.value.interactionMode,
      createdAt: yield* nowIso,
    });
    // Dropped only once sent, so a failed send is retried on the parent's next event.
    // Several results may be waiting; the next goes once this turn ends.
    outcomes.shift();
    if (outcomes.length === 0) undelivered.delete(parentThreadId);
  });

  const settleChild = Effect.fn("DelegationService.settleChild")(function* (
    delegation: Delegation,
  ) {
    const child = yield* snapshots.getThreadShellById(delegation.childThreadId);
    const status = Option.isNone(child) ? "stopped" : delegatedThreadStatus(child.value);
    if (status === null) return;
    running.delete(delegation.childThreadId);
    const text = Option.isNone(child)
      ? "The delegated thread was deleted before it finished."
      : yield* finalMessageOf(delegation.childThreadId, status);
    yield* appendParentActivity(delegation.parentThreadId, {
      id: completedActivityId(delegation.childThreadId),
      tone: status === "failed" ? "error" : "info",
      kind: "task.completed",
      summary: "Delegated task finished",
      payload: {
        taskId: delegation.childThreadId,
        status,
        summary: text,
        delegatedThreadId: delegation.childThreadId,
      },
    });
    const outcomes = undelivered.get(delegation.parentThreadId) ?? [];
    outcomes.push({ delegation, status, text });
    undelivered.set(delegation.parentThreadId, outcomes);
    yield* deliver(delegation.parentThreadId);
  });

  const check = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const delegation = running.get(threadId);
      if (delegation) yield* settleChild(delegation);
      if (undelivered.has(threadId)) yield* deliver(threadId);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("delegation check failed", { threadId, cause: Cause.pretty(cause) }),
      ),
    );

  const worker = yield* makeDrainableWorker(check);
  const isWatched = (threadId: ThreadId) => running.has(threadId) || undelivered.has(threadId);

  /** Delegations a previous process started and never reported back. */
  const recover = Effect.gen(function* () {
    const started = yield* snapshots.listActivitiesByKind("task.started");
    for (const activity of started) {
      const payload = activity.payload as Record<string, unknown> | null;
      if (!activity.id.startsWith("delegation:") || typeof payload !== "object" || !payload) {
        continue;
      }
      const { delegatedThreadId, parentThreadId, title, role } = payload;
      if (typeof delegatedThreadId !== "string" || typeof parentThreadId !== "string") continue;
      const childThreadId = ThreadId.make(delegatedThreadId);
      const delivered = yield* snapshots.getTurnStartMessage({
        threadId: ThreadId.make(parentThreadId),
        messageId: resultMessageId(childThreadId),
      });
      if (Option.isSome(delivered)) continue;
      running.set(childThreadId, {
        childThreadId,
        parentThreadId: ThreadId.make(parentThreadId),
        title: typeof title === "string" ? title : "Delegated task",
        providerName: typeof role === "string" ? role : "The provider",
      });
      yield* worker.enqueue(childThreadId);
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("could not recover delegations", { cause: Cause.pretty(cause) }),
    ),
  );

  const start = Effect.fn("DelegationService.start")(function* () {
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents.pipe(Stream.onStart(recover)), (event) =>
        // Session and checkpoint events end turns; activities resolve approvals and questions.
        (event.type === "thread.session-set" ||
          event.type === "thread.turn-diff-completed" ||
          event.type === "thread.activity-appended" ||
          event.type === "thread.deleted" ||
          event.type === "thread.archived") &&
        isWatched(event.payload.threadId)
          ? worker.enqueue(event.payload.threadId)
          : Effect.void,
      ),
    );
  });

  const delegate = Effect.fn("DelegationService.delegate")(function* (input: DelegateInput) {
    // Read from the thread's creation event, so the rule holds after the task finishes, when
    // the user continues or rewinds it, and across restarts.
    const created = yield* engine
      .readThreadEvents({
        threadId: input.parentThreadId,
        fromSequenceExclusive: 0,
        toSequenceInclusive: Number.MAX_SAFE_INTEGER,
        limit: 1,
      })
      .pipe(
        Stream.runHead,
        Effect.mapError(() => new DelegationError({ message: "Could not read this thread." })),
      );
    if (
      Option.exists(
        created,
        (event) => event.commandId?.startsWith(`server:${CREATE_COMMAND_TAG}:`) === true,
      )
    ) {
      return yield* failWith(
        "This thread is itself a delegated task and cannot delegate further. Do the work here.",
      );
    }
    const parent = yield* snapshots
      .getThreadShellById(input.parentThreadId)
      .pipe(Effect.mapError(() => new DelegationError({ message: "Could not read this thread." })));
    if (Option.isNone(parent)) {
      return yield* failWith(`Thread ${input.parentThreadId} was not found.`);
    }
    const providers = yield* providerRegistry.getProviders;
    const provider = findProvider(providers, input.provider);
    if (!provider) {
      const available = providers
        .filter((candidate) => candidate.enabled && isProviderAvailable(candidate))
        .map((candidate) => `${candidate.instanceId} (${providerLabel(candidate)})`);
      return yield* failWith(
        `No available provider matches "${input.provider}". Available: ${available.join(", ") || "none"}.`,
      );
    }
    let model: string;
    if (input.model !== undefined) {
      const wanted = input.model.trim().toLowerCase();
      const found = provider.models.find(
        (candidate) =>
          candidate.slug.toLowerCase() === wanted ||
          candidate.aliases?.some((alias) => alias.toLowerCase() === wanted),
      );
      if (!found) {
        return yield* failWith(
          `${providerLabel(provider)} has no model "${input.model}". Models: ${provider.models.map((candidate) => candidate.slug).join(", ")}.`,
        );
      }
      model = found.slug;
    } else {
      const fallback = resolveProviderProfileFallbackModelSelection(
        { instanceIds: [provider.instanceId] },
        providers,
      );
      if (!fallback) {
        return yield* failWith(`${providerLabel(provider)} has no model to run with.`);
      }
      model = fallback.model;
    }

    const title = titleFrom(input);
    const childThreadId = ThreadId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
    const modelSelection = { instanceId: provider.instanceId, model };
    const createdAt = yield* nowIso;
    const delegation: Delegation = {
      childThreadId,
      parentThreadId: input.parentThreadId,
      title,
      providerName: providerLabel(provider),
    };
    yield* Effect.gen(function* () {
      yield* engine.dispatch({
        type: "thread.create",
        commandId: yield* commandId(CREATE_COMMAND_TAG),
        threadId: childThreadId,
        projectId: parent.value.projectId,
        title,
        modelSelection,
        runtimeMode: parent.value.runtimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: parent.value.branch,
        worktreePath: parent.value.worktreePath,
        createdAt,
      });
      // Registered before the turn starts so its first events are not missed.
      running.set(childThreadId, delegation);
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: yield* commandId("delegation-turn-start"),
        threadId: childThreadId,
        message: {
          messageId: MessageId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
          role: "user",
          text: `${input.prompt}\n\n---\n${CHILD_PROMPT_FOOTER}`,
          attachments: [],
        },
        modelSelection,
        titleSeed: title,
        runtimeMode: parent.value.runtimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt,
      });
      yield* appendParentActivity(input.parentThreadId, {
        id: startedActivityId(childThreadId),
        tone: "info",
        kind: "task.started",
        summary: "Delegated task started",
        payload: {
          taskId: childThreadId,
          title,
          detail: title,
          role: delegation.providerName,
          model,
          // Server-written rows skip ingestion, so they carry its classification stamp themselves.
          agentKind: "agent",
          delegatedThreadId: childThreadId,
          parentThreadId: input.parentThreadId,
        },
      });
    }).pipe(
      Effect.tapCause(() => Effect.sync(() => running.delete(childThreadId))),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.logWarning("delegation failed to start", { cause: Cause.pretty(cause) }).pipe(
              Effect.andThen(failWith("The delegated thread could not be started.")),
            ),
      ),
    );
    // The turn may already be over if the provider failed fast.
    yield* worker.enqueue(childThreadId);
    return { threadId: childThreadId, title, provider: provider.instanceId, model };
  });

  return DelegationService.of({ start, delegate, drain: worker.drain });
});

export const layer = Layer.effect(DelegationService, make);
