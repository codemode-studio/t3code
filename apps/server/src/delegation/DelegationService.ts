/**
 * Lets an agent hand a task to another provider through the `t3-code` MCP
 * server. The task runs as its own thread in the caller's working copy, the
 * caller's Agents panel tracks it as a subagent, and its final message comes
 * back to the caller's thread as a new message once that thread is idle. The
 * caller can send that thread follow-ups, such as a re-review, and each one
 * reports back the same way.
 *
 * Nothing is stored outside the event log. Each round's `task.started` row on
 * the parent names the child thread, and its result message has an id derived
 * from the round, so after a restart the service finds every round that has
 * not reported back yet and resumes watching it.
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
const FOLLOW_UP_PROMPT_FOOTER =
  "This follow-up comes from the agent that delegated this task. When you finish, your final message is sent back to it as the result, so make it complete and self-contained.";

export class DelegationError extends Schema.TaggedError<DelegationError>()("DelegationError", {
  message: Schema.String,
}) {}

export interface DelegateInput {
  readonly parentThreadId: ThreadId;
  /** A thread this caller delegated earlier; the prompt continues it instead of starting one. */
  readonly threadId?: string | undefined;
  /** A provider instance id, driver kind, or display name, such as "codex". Required for a new task. */
  readonly provider?: string | undefined;
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

/** One request to a delegated thread and the result it owes its parent. */
interface Delegation {
  readonly childThreadId: ThreadId;
  readonly parentThreadId: ThreadId;
  readonly title: string;
  readonly providerName: string;
  readonly resultMessageId: MessageId;
  readonly completedActivityId: EventId;
  /** When a follow-up was requested; null for the first round, the thread's only turn. */
  readonly since: string | null;
}

type DelegationStatus = "completed" | "failed" | "stopped";

interface Outcome {
  readonly delegation: Delegation;
  readonly status: DelegationStatus;
  /** The child's final message, or why it has none. */
  readonly text: string;
}

/**
 * Ids for one round. The first keeps the ids used before follow-ups existed, which the
 * parent link migration also reads; a follow-up is keyed by the message that started it.
 */
const roundIds = (child: ThreadId, followUp: MessageId | null) => {
  const base = followUp === null ? `delegation:${child}` : `delegation:${child}:${followUp}`;
  return {
    started: EventId.make(`${base}:started`),
    resumed: EventId.make(`${base}:resumed`),
    completed: EventId.make(`${base}:completed`),
    result: MessageId.make(base),
  };
};

/**
 * How a delegated thread's round stands; `null` while its turn has not finished. A follow-up
 * (`since` set) reads only turns and session changes from after it was requested: until its
 * own turn starts, the thread still shows the previous round's finished turn.
 */
export function delegatedThreadStatus(
  thread: Pick<OrchestrationThreadShell, "latestTurn" | "session">,
  since: string | null = null,
): DelegationStatus | null {
  if (thread.session?.status === "starting" || thread.session?.status === "running") return null;
  const turn =
    since === null || (thread.latestTurn !== null && thread.latestTurn.requestedAt >= since)
      ? thread.latestTurn
      : null;
  switch (turn?.state) {
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
      if (since !== null && (thread.session === null || thread.session.updatedAt < since)) {
        return null;
      }
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

/** Whether a message can start a new turn on a thread without steering or blocking one. */
function canStartTurn(thread: OrchestrationThreadShell, now: string): boolean {
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
  const followUp = `To follow up in the same thread, for example to ask for a re-review, call delegate_task with threadId "${delegation.childThreadId}". It keeps this conversation.`;
  return `${heading}\n\n${body}\n\n${followUp}`;
}

const titleFrom = (input: Pick<DelegateInput, "title" | "prompt">) => {
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
    if (!canStartTurn(parent.value, yield* nowIso)) return;
    const outcome = outcomes[0]!;
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: yield* commandId("delegation-result"),
      threadId: parentThreadId,
      message: {
        messageId: outcome.delegation.resultMessageId,
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
    const status = Option.isNone(child)
      ? "stopped"
      : delegatedThreadStatus(child.value, delegation.since);
    if (status === null) return;
    running.delete(delegation.childThreadId);
    const text = Option.isNone(child)
      ? "The delegated thread was deleted before it finished."
      : yield* finalMessageOf(delegation.childThreadId, status);
    yield* appendParentActivity(delegation.parentThreadId, {
      id: delegation.completedActivityId,
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
      const { delegatedThreadId, parentThreadId, title, role, followUp, requestedAt } = payload;
      if (typeof delegatedThreadId !== "string" || typeof parentThreadId !== "string") continue;
      const childThreadId = ThreadId.make(delegatedThreadId);
      const ids = roundIds(
        childThreadId,
        typeof followUp === "string" ? MessageId.make(followUp) : null,
      );
      const delivered = yield* snapshots.getTurnStartMessage({
        threadId: ThreadId.make(parentThreadId),
        messageId: ids.result,
      });
      if (Option.isSome(delivered)) continue;
      running.set(childThreadId, {
        childThreadId,
        parentThreadId: ThreadId.make(parentThreadId),
        title: typeof title === "string" ? title : "Delegated task",
        providerName: typeof role === "string" ? role : "The provider",
        resultMessageId: ids.result,
        completedActivityId: ids.completed,
        since: typeof followUp === "string" && typeof requestedAt === "string" ? requestedAt : null,
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

  const readThread = (threadId: ThreadId) =>
    snapshots
      .getThreadShellById(threadId)
      .pipe(Effect.mapError(() => new DelegationError({ message: "Could not read this thread." })));

  /** Sends a delegated thread a follow-up that reports back like the first request. */
  const continueDelegation = Effect.fn("DelegationService.continueDelegation")(function* (
    input: DelegateInput,
    childThreadId: ThreadId,
  ) {
    const child = yield* readThread(childThreadId);
    if (Option.isNone(child) || child.value.parentThreadId !== input.parentThreadId) {
      return yield* failWith(
        `Thread ${childThreadId} is not a task this thread delegated. Leave out threadId to start a new one.`,
      );
    }
    if (child.value.archivedAt !== null) {
      return yield* failWith(
        "That delegated thread was archived. Leave out threadId to start a new task.",
      );
    }
    const owesResult =
      running.has(childThreadId) ||
      (undelivered.get(input.parentThreadId) ?? []).some(
        (outcome) => outcome.delegation.childThreadId === childThreadId,
      );
    if (owesResult) {
      return yield* failWith(
        "That thread has not reported back on your last request yet. End your turn; its result arrives as a new message.",
      );
    }
    const now = yield* nowIso;
    if (!canStartTurn(child.value, now)) {
      return yield* failWith(
        "That thread is busy with a turn or waiting for an answer. Try again once it is idle.",
      );
    }
    const instanceId =
      child.value.session?.providerInstanceId ?? child.value.modelSelection.instanceId;
    const provider = (yield* providerRegistry.getProviders).find(
      (candidate) => candidate.instanceId === instanceId,
    );
    const messageId = MessageId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
    const ids = roundIds(childThreadId, messageId);
    const delegation: Delegation = {
      childThreadId,
      parentThreadId: input.parentThreadId,
      title: child.value.title,
      providerName: provider
        ? providerLabel(provider)
        : (child.value.session?.providerName ?? "The delegated agent"),
      resultMessageId: ids.result,
      completedActivityId: ids.completed,
      since: now,
    };
    yield* Effect.gen(function* () {
      // Registered before the turn starts so its first events are not missed.
      running.set(childThreadId, delegation);
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: yield* commandId("delegation-follow-up"),
        threadId: childThreadId,
        message: {
          messageId,
          role: "user",
          text: `${input.prompt}\n\n---\n${FOLLOW_UP_PROMPT_FOOTER}`,
          attachments: [],
        },
        runtimeMode: child.value.runtimeMode,
        interactionMode: child.value.interactionMode,
        createdAt: now,
      });
      yield* appendParentActivity(input.parentThreadId, {
        id: ids.started,
        tone: "info",
        kind: "task.started",
        summary: "Delegated task continued",
        payload: {
          // The same task id, so the Agents panel counts this as another run of that agent.
          taskId: childThreadId,
          title: delegation.title,
          detail: delegation.title,
          role: delegation.providerName,
          model: child.value.modelSelection.model,
          agentKind: "agent",
          delegatedThreadId: childThreadId,
          parentThreadId: input.parentThreadId,
          followUp: messageId,
          requestedAt: now,
        },
      });
      // The Agents panel ignores a start row for a finished agent; only a status change
      // reopens it as another run.
      yield* appendParentActivity(input.parentThreadId, {
        id: ids.resumed,
        tone: "info",
        kind: "task.updated",
        summary: "Delegated task continued",
        payload: { taskId: childThreadId, status: "running", delegatedThreadId: childThreadId },
      });
    }).pipe(
      Effect.tapCause(() => Effect.sync(() => running.delete(childThreadId))),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.logWarning("delegation follow-up failed to start", {
              cause: Cause.pretty(cause),
            }).pipe(Effect.andThen(failWith("The follow-up could not be sent."))),
      ),
    );
    yield* worker.enqueue(childThreadId);
    return {
      threadId: childThreadId,
      title: delegation.title,
      provider: child.value.modelSelection.instanceId,
      model: child.value.modelSelection.model,
    };
  });

  const delegate = Effect.fn("DelegationService.delegate")(function* (input: DelegateInput) {
    const parent = yield* readThread(input.parentThreadId);
    if (Option.isNone(parent)) {
      return yield* failWith(`Thread ${input.parentThreadId} was not found.`);
    }
    // Set at creation, so the rule holds after the task finishes, when the user continues or
    // rewinds it, and across restarts.
    if (parent.value.parentThreadId != null) {
      return yield* failWith(
        "This thread is itself a delegated task and cannot delegate further. Do the work here.",
      );
    }
    if (input.threadId !== undefined) {
      return yield* continueDelegation(input, ThreadId.make(input.threadId));
    }
    if (input.provider === undefined) {
      return yield* failWith(
        "Name a provider to start a new task, or pass threadId to continue one you delegated.",
      );
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
    const ids = roundIds(childThreadId, null);
    const delegation: Delegation = {
      childThreadId,
      parentThreadId: input.parentThreadId,
      title,
      providerName: providerLabel(provider),
      resultMessageId: ids.result,
      completedActivityId: ids.completed,
      since: null,
    };
    yield* Effect.gen(function* () {
      yield* engine.dispatch({
        type: "thread.create",
        commandId: yield* commandId("delegation-thread-create"),
        threadId: childThreadId,
        parentThreadId: input.parentThreadId,
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
        id: ids.started,
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
