/**
 * Automations: saved prompts that start agent runs on a schedule or when GitHub activity lands.
 *
 * The records live in `automations.json` in the state directory. A run launches a thread in the
 * automation's project (in a fresh worktree or the project checkout) through the same V2 launch
 * path a user's first message takes, or sends another message to the thread a continued
 * conversation keeps. Once that run ends, the agent's last message is saved on the run as its
 * summary, later replaced by one the text generation model writes, and with
 * `deleteThreadWhenDone`, the run's thread is deleted.
 *
 * @module AutomationService
 */
import * as NodeCrypto from "node:crypto";

import {
  Automation,
  AUTOMATION_MAX_RUNS,
  AUTOMATION_RUN_SUMMARY_MAX_LENGTH,
  AutomationError,
  type AutomationConfig,
  type AutomationGitHubEvent,
  type AutomationRun,
  type AutomationsSnapshot,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  IsoDateTime,
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import {
  AUTOMATION_GITHUB_EVENT_LABELS,
  describeTrigger,
  latestTriggerAt,
} from "@t3tools/shared/automationSchedule";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import {
  resolveProjectSettings,
  resolveProviderProfile,
  resolveProviderProfileFallbackModelSelection,
} from "@t3tools/shared/projectSettings";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { RUN_SUMMARY_TRANSCRIPT_MAX_LENGTH } from "../textGeneration/TextGenerationPrompts.ts";

/** A run that has not ended yet; `messageAt` is when the run's message was sent. */
const PendingRun = Schema.Struct({
  /** Absent, with `messageId`, on entries saved before runs kept summaries. */
  runId: Schema.optional(Schema.String),
  threadId: ThreadId,
  /** The run's message. */
  messageId: Schema.optional(MessageId),
  /** The orchestration run the message started; absent on entries saved before V2. */
  orchestrationRunId: Schema.optional(RunId),
  messageAt: IsoDateTime,
  /** Defaults on for those older entries, which were all thread deletes. */
  deleteThread: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
type PendingRun = typeof PendingRun.Type;

/**
 * What the file keeps beyond the public record: how far each trigger source has been read, and
 * which runs still wait to end.
 */
const StoredAutomation = Schema.Struct({
  ...Automation.fields,
  /**
   * When the last scheduled run started or the automation was last saved; only later times can
   * start a run. It moves only then, so an idle tick never rewrites the file.
   */
  scheduleCursor: IsoDateTime,
  /** GitHub items created at or before this instant have been handled; null until first poll. */
  githubCursor: Schema.NullOr(IsoDateTime),
  /** Kept apart from the capped run history, so newer runs cannot drop an older run's cleanup. */
  pendingRuns: Schema.Array(PendingRun).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** The name `pendingRuns` had before it held every run; moved there on load. */
  pendingThreadDeletes: Schema.optional(Schema.Array(PendingRun)),
});
type StoredAutomation = typeof StoredAutomation.Type;

const AutomationsFile = Schema.Struct({
  automations: Schema.Array(StoredAutomation),
});
type AutomationsFile = typeof AutomationsFile.Type;

const decodeAutomationsFile = Schema.decodeUnknownEffect(Schema.fromJsonString(AutomationsFile));
const encodeAutomationsFile = Schema.encodeEffect(fromJsonStringPretty(AutomationsFile));

const GitHubItem = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  createdAt: Schema.String,
  isDraft: Schema.optional(Schema.Boolean),
});
type GitHubItem = typeof GitHubItem.Type;
const decodeGitHubItems = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(GitHubItem)),
);

const SCHEDULE_TICK = "30 seconds";
const GITHUB_POLL_INTERVAL_MS = 2 * 60_000;
/** A scheduled time is never "missed" just because the tick landed a little after it. */
const MIN_CATCH_UP_MS = 2 * 60_000;
/** GitHub items handled per automation per poll, so a burst cannot fan out into dozens of runs. */
const MAX_GITHUB_RUNS_PER_POLL = 5;
/** Generations run one at a time, so a hung provider must not hold up every later summary. */
const SUMMARY_GENERATION_TIMEOUT = Duration.minutes(3);

export class AutomationService extends Context.Service<
  AutomationService,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly changes: Stream.Stream<AutomationsSnapshot>;
    readonly create: (config: AutomationConfig) => Effect.Effect<Automation, AutomationError>;
    readonly update: (
      id: string,
      config: AutomationConfig,
    ) => Effect.Effect<Automation, AutomationError>;
    readonly remove: (id: string) => Effect.Effect<void, AutomationError>;
    readonly runNow: (id: string) => Effect.Effect<AutomationRun, AutomationError>;
  }
>()("t3/automation/AutomationService") {}

function toPublic(stored: StoredAutomation): Automation {
  const {
    scheduleCursor: _scheduleCursor,
    githubCursor: _githubCursor,
    pendingRuns: _pendingRuns,
    pendingThreadDeletes: _pendingThreadDeletes,
    ...automation
  } = stored;
  return automation;
}

function migrateStored({
  pendingThreadDeletes = [],
  ...stored
}: StoredAutomation): StoredAutomation {
  return { ...stored, pendingRuns: [...stored.pendingRuns, ...pendingThreadDeletes] };
}

/** A continued conversation's thread outlives the run, so only fresh ones are deleted. */
function deletesRunThreads(config: AutomationConfig): boolean {
  return config.deleteThreadWhenDone && config.conversation === "fresh";
}

/** Several only in a continued conversation, where each run sends another message to one thread. */
function pendingRunsOf(file: AutomationsFile, threadId: ThreadId): ReadonlyArray<PendingRun> {
  return file.automations.flatMap((automation) =>
    automation.pendingRuns.filter((entry) => entry.threadId === threadId),
  );
}

const samePendingRun = (a: PendingRun, b: PendingRun) =>
  a.runId === b.runId && a.threadId === b.threadId && a.messageAt === b.messageAt;

function toSnapshot(file: AutomationsFile): AutomationsSnapshot {
  return {
    automations: file.automations.map(toPublic),
    // Schedules run in the host's local zone, which is what `latestTriggerAt` defaults to.
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

function githubItemMatches(event: AutomationGitHubEvent, item: GitHubItem): boolean {
  switch (event) {
    case "pull_request.opened":
      return item.isDraft !== true;
    case "pull_request.draft_opened":
      return item.isDraft === true;
    case "issue.opened":
      return true;
  }
}

/** Server notifications and delegated completions wake the agent; they are not the user writing. */
function isUserWritten(message: OrchestrationV2ConversationMessage): boolean {
  return (
    message.role === "user" &&
    message.notification === undefined &&
    message.delegatedCompletion === undefined
  );
}

/**
 * What to do with a run's thread: delete it when the run completed and asked for that, or keep
 * it, also when the run failed or was stopped so the user can see why, or when the user wrote in
 * it. Waits while the run, a request it raised, or background work it left is still going.
 * `messages` is read only once some run ended, so it is absent while every run still waits.
 */
function runThreadOutcome(input: {
  readonly pending: PendingRun;
  readonly run: OrchestrationV2Run | undefined;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage> | undefined;
  readonly waitingOnThread: boolean;
}): "delete" | "keep" | "wait" {
  const { pending, run } = input;
  // The message never got a run: it was rejected, so there is nothing to wait for.
  if (run === undefined) return "keep";
  if (ThreadManagementService.isActiveRun(run) || run.status === "queued") return "wait";
  if (run.status !== "completed") return "keep";
  if (input.waitingOnThread) return "wait";
  const userWrote =
    input.runs.some((other) => other.ordinal > run.ordinal) ||
    (input.messages ?? []).some(
      (message) =>
        isUserWritten(message) &&
        message.id !== pending.messageId &&
        DateTime.toEpochMillis(message.createdAt) >= Date.parse(pending.messageAt),
    );
  return pending.deleteThread && !userWrote ? "delete" : "keep";
}

/** The newest messages that fit what a summary reads; always the last one. */
function summaryTranscript(agentMessages: ReadonlyArray<string>): ReadonlyArray<string> {
  let length = 0;
  let start = agentMessages.length;
  while (start > 0) {
    length += agentMessages[start - 1]!.length;
    if (length > RUN_SUMMARY_TRANSCRIPT_MAX_LENGTH && start < agentMessages.length) break;
    start--;
  }
  return agentMessages.slice(start);
}

function capSummary(summary: string): string {
  return summary.length > AUTOMATION_RUN_SUMMARY_MAX_LENGTH
    ? `${summary.slice(0, AUTOMATION_RUN_SUMMARY_MAX_LENGTH - 1).trimEnd()}…`
    : summary;
}

/** Events that can end a run, answer a request it raised, or remove its thread. */
function settlesRuns(event: OrchestrationV2DomainEvent): boolean {
  return (
    event.type === "run.updated" ||
    event.type === "thread.deleted" ||
    event.type === "runtime-request.updated" ||
    event.type === "subagent.updated"
  );
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const gitHubCli = yield* GitHubCli.GitHubCli;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const textGeneration = yield* TextGeneration.TextGeneration;

  const filePath = path.join(config.stateDir, "automations.json");
  // Captured so writes from RPC handlers and the scheduler fiber need no extra services.
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

  const initial: AutomationsFile = yield* fs.readFileString(filePath).pipe(
    Effect.flatMap(decodeAutomationsFile),
    Effect.catch((cause) =>
      fs.exists(filePath).pipe(
        Effect.orElseSucceed(() => false),
        Effect.flatMap((exists) =>
          exists
            ? Effect.logWarning("automations file could not be read; starting empty", {
                filePath,
                detail: String(cause),
              })
            : Effect.void,
        ),
        Effect.as({ automations: [] }),
      ),
    ),
    Effect.map((file) => ({ automations: file.automations.map(migrateStored) })),
  );
  const state = yield* SubscriptionRef.make<AutomationsFile>(initial);
  const writeLock = yield* Semaphore.make(1);

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const newId = crypto.randomUUIDv4.pipe(Effect.orDie);

  const persist = (file: AutomationsFile) =>
    encodeAutomationsFile(file).pipe(
      Effect.flatMap((contents) => writeFileStringAtomically({ filePath, contents })),
      Effect.provide(services),
      Effect.mapError(
        (cause) => new AutomationError({ message: `Failed to save automations: ${String(cause)}` }),
      ),
    );

  /** Applies `f` to the stored list and writes it, one writer at a time. */
  const modify = <A>(
    f: (file: AutomationsFile) => Effect.Effect<readonly [A, AutomationsFile], AutomationError>,
  ) =>
    writeLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        const [result, next] = yield* f(current);
        yield* persist(next);
        yield* SubscriptionRef.set(state, next);
        return result;
      }),
    );

  const patchAutomation = (id: string, patch: (stored: StoredAutomation) => StoredAutomation) =>
    modify((file) =>
      Effect.succeed([
        undefined,
        {
          automations: file.automations.map((entry) => (entry.id === id ? patch(entry) : entry)),
        },
      ] as const),
    );

  const findAutomation = (id: string) =>
    SubscriptionRef.get(state).pipe(
      Effect.flatMap((file) => {
        const found = file.automations.find((entry) => entry.id === id);
        return found
          ? Effect.succeed(found)
          : Effect.fail(new AutomationError({ message: "Automation not found." }));
      }),
    );

  const failWith = (message: string) => Effect.fail(new AutomationError({ message }));

  const findProject = (projectId: StoredAutomation["projectId"]) =>
    projects.getById(projectId).pipe(Effect.map(Option.getOrUndefined));

  /**
   * Saves summaries on their runs and settles pending runs of `threadId`: `kept` drops the given
   * ones, `deleting` keeps them pending until the delete lands, and `deleted` drops every run of
   * the thread and marks them, since the thread is gone.
   */
  const recordPendingRuns = (
    threadId: ThreadId,
    finished: ReadonlyArray<{ readonly entry: PendingRun; readonly summary: string | undefined }>,
    outcome: "kept" | "deleting" | "deleted",
  ) =>
    modify((file) =>
      Effect.succeed([
        undefined,
        {
          automations: file.automations.map((automation) => ({
            ...automation,
            pendingRuns: automation.pendingRuns.filter((entry) =>
              outcome === "deleted"
                ? entry.threadId !== threadId
                : outcome === "deleting" ||
                  !finished.some((done) => samePendingRun(done.entry, entry)),
            ),
            runs: automation.runs.map((run) => {
              const summary = finished.find((done) => done.entry.runId === run.id)?.summary;
              return {
                ...run,
                ...(summary === undefined ? {} : { summary }),
                ...(outcome === "deleted" && run.threadId === threadId
                  ? { threadDeleted: true }
                  : {}),
              };
            }),
          })),
        },
      ] as const),
    );

  /**
   * Replaces a run's saved last message with a summary from the project's text generation model.
   * Failing leaves the last message in place.
   */
  const summaryWorker = yield* makeDrainableWorker(
    (job: { readonly runId: string; readonly agentMessages: ReadonlyArray<string> }) =>
      Effect.gen(function* () {
        const automation = (yield* SubscriptionRef.get(state)).automations.find((entry) =>
          entry.runs.some((run) => run.id === job.runId),
        );
        if (automation === undefined) return;
        const project = yield* findProject(automation.projectId);
        if (project === undefined) return;
        const { textGenerationModelSelection } = resolveProjectSettings(
          yield* settingsService.getSettings,
          project.id,
        ).settings;
        const { summary } = yield* textGeneration
          .generateRunSummary({
            cwd: project.workspaceRoot,
            instructions: automation.prompt,
            agentMessages: job.agentMessages,
            modelSelection: textGenerationModelSelection,
          })
          .pipe(Effect.timeout(SUMMARY_GENERATION_TIMEOUT));
        if (summary === "") return;
        yield* patchAutomation(automation.id, (stored) => ({
          ...stored,
          runs: stored.runs.map((run) =>
            run.id === job.runId ? { ...run, summary: capSummary(summary) } : run,
          ),
        }));
      }).pipe(
        Effect.catchCause((failure) =>
          Effect.logWarning("automation run summary generation failed", {
            runId: job.runId,
            cause: Cause.pretty(failure),
          }),
        ),
      ),
  );

  const cleanupLock = yield* Semaphore.make(1);
  /**
   * Settles a thread's pending runs that ended: saves their summaries and deletes the thread when
   * a run asked for that. Safe to call at any time; one call at a time. The delete carries the
   * thread's event sequence read before its records, so the orchestrator rejects it if anything,
   * such as a new user message, reached the thread after that read.
   */
  const settleRunThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const pending = pendingRunsOf(yield* SubscriptionRef.get(state), threadId);
      if (pending.length === 0) return;
      const expectedSequence = yield* threads.getThreadEventSequence(threadId);
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null) {
        // Deleted some other way, e.g. by the user.
        return yield* recordPendingRuns(threadId, [], "deleted");
      }
      const records = yield* threads.getThreadRecords(threadId, ["runs"]);
      if (records.thread.deletedAt !== null) {
        return yield* recordPendingRuns(threadId, [], "deleted");
      }
      const latest = ThreadManagementService.latestRun(records);
      const waitingOnThread =
        shell.pendingRuntimeRequest !== null || (shell.pendingBackgroundTasks ?? []).length > 0;
      // Background work reports through turn items, which stream too often to watch otherwise.
      if (waitingOnThread) waitingOnBackground.add(threadId);
      else waitingOnBackground.delete(threadId);
      // Entries saved before V2 belong to fresh threads, whose latest run is the run's.
      const runOf = (entry: PendingRun) =>
        entry.orchestrationRunId === undefined
          ? latest
          : records.runs.find((candidate) => candidate.id === entry.orchestrationRunId);
      const outcomeOf = (
        entry: PendingRun,
        messages: ReadonlyArray<OrchestrationV2ConversationMessage> | undefined,
      ) =>
        runThreadOutcome({
          pending: entry,
          run: runOf(entry),
          runs: records.runs,
          messages,
          waitingOnThread,
        });
      if (pending.every((entry) => outcomeOf(entry, undefined) === "wait")) return;
      const { messages } = yield* threads.getThreadRecords(threadId, ["messages"], {
        messageRoles: ["user", "assistant"],
      });
      const ended = pending.flatMap((entry) => {
        const outcome = outcomeOf(entry, messages);
        return outcome === "wait" ? [] : [{ entry, outcome, run: runOf(entry) }];
      });
      if (ended.length === 0) return;
      const finished = ended.map(({ entry, run }) => {
        const agentMessages =
          run === undefined
            ? []
            : messages
                .filter((message) => message.runId === run.id && message.role === "assistant")
                .toSorted(
                  (left, right) =>
                    DateTime.toEpochMillis(left.createdAt) -
                    DateTime.toEpochMillis(right.createdAt),
                )
                .map((message) => message.text.trim())
                .filter((text) => text !== "");
        const last = agentMessages.at(-1);
        return {
          entry,
          agentMessages,
          summary: last === undefined ? undefined : capSummary(last),
        };
      });
      // Generated after the last message is saved, so a failed or interrupted generation still
      // leaves a summary.
      const summarize = Effect.forEach(
        finished,
        ({ entry, agentMessages }) =>
          entry.runId === undefined || agentMessages.length === 0
            ? Effect.void
            : summaryWorker.enqueue({
                runId: entry.runId,
                agentMessages: summaryTranscript(agentMessages),
              }),
        { discard: true },
      );
      if (!ended.some(({ outcome }) => outcome === "delete")) {
        yield* recordPendingRuns(threadId, finished, "kept");
        return yield* summarize;
      }
      // Saved before the delete takes the messages with it, so a failed write cannot lose them.
      yield* recordPendingRuns(threadId, finished, "deleting");
      const deleted = yield* threads
        .dispatch({
          type: "thread.delete",
          commandId: CommandId.make(`server:automation-thread-delete:${yield* newId}`),
          threadId,
          expectedSequence,
        })
        .pipe(
          Effect.as(true),
          Effect.catchTag("OrchestratorDispatchError", (error) =>
            threads.getThreadEventSequence(threadId).pipe(
              // Only a thread that moved past the read is decided again against a fresh one;
              // any other rejection waits for the next event instead of retrying in a loop.
              Effect.flatMap((sequence) =>
                sequence > expectedSequence
                  ? recheck(threadId)
                  : Effect.logWarning("automation thread delete rejected", {
                      threadId,
                      cause: error,
                    }),
              ),
              Effect.as(false),
            ),
          ),
        );
      if (!deleted) return;
      yield* recordPendingRuns(threadId, [], "deleted");
      yield* summarize;
    }).pipe(
      cleanupLock.withPermits(1),
      Effect.catchCause((failure) =>
        Effect.logWarning("automation run settlement failed", {
          threadId,
          cause: Cause.pretty(failure),
        }),
      ),
    );

  // Off the event stream, so a slow lookup or dispatch never holds up the orchestrator's
  // subscribers. A thread already queued is not queued again; it is dequeued before it is read,
  // so an event arriving during a check still queues the next one.
  const queued = new Set<ThreadId>();
  const waitingOnBackground = new Set<ThreadId>();
  const cleanup = yield* makeDrainableWorker((threadId: ThreadId) =>
    Effect.suspend(() => {
      queued.delete(threadId);
      return settleRunThread(threadId);
    }),
  );
  // Annotated: the worker, `settleRunThread` and this refer to one another. A retry from inside
  // `settleRunThread` only enqueues, so it cannot wait on the lock it holds.
  const recheck = (threadId: ThreadId): Effect.Effect<void> =>
    SubscriptionRef.get(state).pipe(
      Effect.flatMap((file) => {
        if (queued.has(threadId) || pendingRunsOf(file, threadId).length === 0) {
          return Effect.void;
        }
        queued.add(threadId);
        return cleanup.enqueue(threadId);
      }),
    );

  /**
   * Checks a pull request out detached in a fresh worktree. The PR's branch is usually still
   * checked out by the thread that wrote it, and git allows a branch in only one worktree, so a
   * review works on the head commit instead of leaving behind a branch nobody pushes. `gh`
   * resolves the same repository `gh pr list` found the PR in, forks included.
   */
  const createPullRequestWorktree = Effect.fn("AutomationService.createPullRequestWorktree")(
    function* (workspaceRoot: string, pullRequestNumber: number) {
      const created = yield* gitWorkflow.createWorktree({
        cwd: workspaceRoot,
        refName: "HEAD",
        path: path.join(
          config.worktreesDir,
          path.basename(workspaceRoot),
          `pr-${pullRequestNumber}-${NodeCrypto.randomBytes(4).toString("hex")}`,
        ),
      });
      const worktreePath = created.worktree.path;
      yield* gitHubCli
        .execute({
          cwd: worktreePath,
          args: ["pr", "checkout", String(pullRequestNumber), "--detach"],
          timeoutMs: 120_000,
        })
        .pipe(
          Effect.onError(() =>
            gitWorkflow
              .removeWorktree({ cwd: workspaceRoot, path: worktreePath, force: true })
              .pipe(Effect.ignoreCause({ log: true })),
          ),
        );
      return worktreePath;
    },
  );

  /** Where a fresh run works: a new worktree, the PR head, or the project checkout. */
  const workspaceFor = Effect.fn("AutomationService.workspaceFor")(function* (
    automation: StoredAutomation,
    workspaceRoot: string,
    pullRequest: GitHubItem | null,
  ) {
    const inWorktree =
      automation.workingCopy === "worktree" && (yield* gitWorkflow.isRepository(workspaceRoot));
    if (inWorktree && pullRequest !== null) {
      return {
        strategy: {
          type: "existing_worktree",
          worktreePath: yield* createPullRequestWorktree(workspaceRoot, pullRequest.number),
        } satisfies ThreadLaunchService.ThreadLaunchWorkspaceStrategy,
        detachedAtPullRequest: true,
      };
    }
    if (inWorktree) {
      const status = yield* gitWorkflow.localStatus({ cwd: workspaceRoot });
      if (status.refName === null) {
        return yield* failWith("The project checkout is not on a branch to start a worktree from.");
      }
      return {
        strategy: {
          type: "worktree",
          baseRef: status.refName,
        } satisfies ThreadLaunchService.ThreadLaunchWorkspaceStrategy,
        detachedAtPullRequest: false,
      };
    }
    return {
      strategy: { type: "root" } satisfies ThreadLaunchService.ThreadLaunchWorkspaceStrategy,
      detachedAtPullRequest: false,
    };
  });

  /**
   * Starts one run and records it. Never fails: a failed run is a run with an error.
   * `pullRequest` is set when a pull request triggered the run; its thread is linked to it.
   */
  const executeRun = (
    automation: StoredAutomation,
    cause: string,
    context: string | null,
    pullRequest: GitHubItem | null,
  ) =>
    Effect.gen(function* () {
      const project = yield* findProject(automation.projectId);
      if (!project || project.deletedAt !== null) {
        return yield* failWith("The automation's project no longer exists.");
      }
      const settings = yield* settingsService.getSettings;
      const projectSettings = resolveProjectSettings(settings, project.id).settings;
      const providerProfile = resolveProviderProfile(projectSettings);
      // With a profile, a missing default resolves inside it; the environment
      // default may belong to another profile's account.
      const modelSelection =
        automation.modelSelection ??
        projectSettings.defaultModelSelection ??
        (providerProfile
          ? resolveProviderProfileFallbackModelSelection(
              providerProfile,
              yield* providerRegistry.getProviders,
            )
          : settings.defaultModelSelection);
      if (!modelSelection) {
        return yield* failWith("Choose a model for this automation.");
      }

      const previousThreadId =
        automation.conversation === "continue"
          ? (automation.runs.find((run) => run.threadId !== null)?.threadId ?? null)
          : null;
      const previousThread = previousThreadId
        ? yield* threads.getThreadShell(previousThreadId)
        : null;
      const continued =
        previousThread !== null && previousThread.archivedAt === null ? previousThread : null;
      // One run at a time per thread: a second message before the first ends would queue behind
      // it, and the user could not tell which run a reply belongs to.
      if (
        continued !== null &&
        pendingRunsOf(yield* SubscriptionRef.get(state), continued.id).length > 0
      ) {
        return yield* failWith(
          "The previous run is still going or waiting for you in the same thread.",
        );
      }

      const runKey = yield* newId;
      const messageId = MessageId.make(`automation-message:${runKey}`);
      const commandId = CommandId.make(`server:automation-run:${runKey}`);
      const messageAt = yield* nowIso;
      let threadId: ThreadId;
      let orchestrationRunId: RunId | undefined;
      if (continued !== null) {
        threadId = continued.id;
        const sent = yield* threads.sendToThread({
          projectId: project.id,
          commandId,
          threadId,
          messageId,
          text: context === null ? automation.prompt : `${automation.prompt}\n\n---\n${context}`,
          attachments: [],
          modelSelection,
          // Behind any run the user started in the meantime, never steering into it.
          mode: "queue",
          createdBy: "user",
          creationSource: "server",
        });
        orchestrationRunId = sent.run.id;
      } else {
        const workspace = yield* workspaceFor(automation, project.workspaceRoot, pullRequest);
        const runContext =
          pullRequest !== null && workspace.detachedAtPullRequest
            ? `${context ?? ""}\nThis worktree is checked out detached at the pull request's head. To review newer commits, run \`gh pr checkout ${pullRequest.number} --detach\`.`
            : context;
        const launched = yield* threadLaunch.launch({
          commandId,
          projectId: project.id,
          title: automation.name,
          modelSelection,
          runtimeMode: automation.runtimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          workspaceStrategy: workspace.strategy,
          initialMessage: {
            messageId,
            text: runContext ? `${automation.prompt}\n\n---\n${runContext}` : automation.prompt,
            attachments: [],
          },
          createdBy: "user",
          creationSource: "server",
        });
        threadId = launched.threadId;
        orchestrationRunId =
          launched.projection.messages.find((candidate) => candidate.id === messageId)?.runId ??
          undefined;
      }

      const link = pullRequest === null ? null : parseChangeRequestUrl(pullRequest.url);
      if (pullRequest !== null && link !== null) {
        yield* threads
          .dispatch({
            type: "thread.pull-request.link",
            commandId: CommandId.make(`server:automation-pr-link:${yield* newId}`),
            threadId,
            ...link,
            url: pullRequest.url,
            source: "manual",
          })
          // Already linked (a continued conversation reviewing it again) is the goal state.
          .pipe(Effect.ignoreCause({ log: true }));
      }
      return { threadId, messageId, messageAt, orchestrationRunId };
    }).pipe(
      Effect.map((started) => ({ ...started, error: null })),
      Effect.catchCause((failure) =>
        Effect.logWarning("automation run failed", {
          automationId: automation.id,
          cause: Cause.pretty(failure),
        }).pipe(
          Effect.as({
            threadId: null,
            messageId: null,
            messageAt: null,
            orchestrationRunId: undefined,
            error:
              Cause.squash(failure) instanceof Error
                ? (Cause.squash(failure) as Error).message
                : "The run failed to start.",
          }),
        ),
      ),
      Effect.flatMap(({ threadId, messageId, messageAt, orchestrationRunId, error }) =>
        Effect.gen(function* () {
          const run: AutomationRun = {
            id: yield* newId,
            startedAt: yield* nowIso,
            cause,
            threadId,
            error,
          };
          yield* patchAutomation(automation.id, (stored) => {
            const runs = [run, ...stored.runs].slice(0, AUTOMATION_MAX_RUNS);
            const pendingRuns =
              threadId !== null && messageId !== null && messageAt !== null
                ? [
                    ...stored.pendingRuns,
                    {
                      runId: run.id,
                      threadId,
                      messageId,
                      ...(orchestrationRunId === undefined ? {} : { orchestrationRunId }),
                      messageAt,
                      // The run's config made the thread and the stored one may have been
                      // edited while it started; both must still delete it.
                      deleteThread: deletesRunThreads(automation) && deletesRunThreads(stored),
                    },
                  ]
                : stored.pendingRuns;
            return {
              ...stored,
              runs,
              // A run that fell out of the history has nowhere to keep its summary.
              pendingRuns: pendingRuns.filter(
                (entry) => entry.deleteThread || runs.some((kept) => kept.id === entry.runId),
              ),
            };
          }).pipe(Effect.ignoreCause({ log: true }));
          // The run may have ended before it was recorded. Queued, so the automation is free for
          // its next trigger without waiting on the check.
          if (threadId !== null) yield* recheck(threadId);
          return run;
        }),
      ),
    );

  /**
   * Automations with a run starting or a GitHub poll going. That work runs off the tick loop, so
   * a slow worktree or `gh` call holds up only its own automation, which ticks skip until it is
   * done. A skipped due time still starts afterwards if it is within the catch-up window.
   */
  const busy = new Set<string>();
  const inBackground = (id: string, work: Effect.Effect<unknown, AutomationError>) =>
    Effect.suspend(() => {
      if (busy.has(id)) return Effect.void;
      busy.add(id);
      return work.pipe(
        Effect.catchCause((failure) =>
          Effect.logWarning("automation background work failed", {
            automationId: id,
            cause: Cause.pretty(failure),
          }),
        ),
        Effect.ensuring(Effect.sync(() => busy.delete(id))),
        Effect.forkChild,
        Effect.asVoid,
      );
    });

  const scheduleTick = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const nowText = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
    const file = yield* SubscriptionRef.get(state);
    for (const automation of file.automations) {
      if (!automation.enabled) continue;
      const cursorMs = Date.parse(automation.scheduleCursor);
      const window = Math.max(automation.catchUpMinutes * 60_000, MIN_CATCH_UP_MS);
      const due = automation.triggers.flatMap((trigger) => {
        if (trigger.type === "github") return [];
        const at = latestTriggerAt(trigger, nowMs);
        if (at === null) return [];
        return at > cursorMs && nowMs - at <= window ? [trigger] : [];
      });
      // Two schedules due in the same tick are one run, not two copies of the same work.
      const [first] = due;
      if (!first) continue;
      yield* inBackground(
        automation.id,
        // Recorded before the run starts, so a crash mid-run cannot start it again on restart.
        patchAutomation(automation.id, (stored) => ({ ...stored, scheduleCursor: nowText })).pipe(
          Effect.andThen(executeRun(automation, describeTrigger(first), null, null)),
        ),
      );
    }
  });

  const listGitHubItems = (cwd: string, kind: "pr" | "issue") =>
    gitHubCli
      .execute({
        cwd,
        args: [
          kind,
          "list",
          "--state",
          "open",
          "--limit",
          "30",
          "--json",
          kind === "pr" ? "number,title,url,createdAt,isDraft" : "number,title,url,createdAt",
        ],
        timeoutMs: 30_000,
      })
      .pipe(Effect.flatMap((output) => decodeGitHubItems(output.stdout)));

  const pollGitHub = (automation: StoredAutomation) =>
    Effect.gen(function* () {
      const events = automation.triggers.flatMap((trigger) =>
        trigger.type === "github" ? [trigger.event] : [],
      );
      if (events.length === 0) return;
      const project = yield* findProject(automation.projectId);
      if (!project || project.deletedAt !== null) return;
      const startedAt = yield* nowIso;
      if (automation.githubCursor === null) {
        // Only activity after the automation starts watching counts.
        yield* patchAutomation(automation.id, (stored) => ({
          ...stored,
          githubCursor: startedAt,
        }));
        return;
      }
      const since = automation.githubCursor;
      const wantsPullRequests = events.some((event) => event !== "issue.opened");
      const wantsIssues = events.includes("issue.opened");
      const pullRequests = wantsPullRequests
        ? yield* listGitHubItems(project.workspaceRoot, "pr")
        : [];
      const issues = wantsIssues ? yield* listGitHubItems(project.workspaceRoot, "issue") : [];

      const fresh = [
        ...pullRequests.map((item) => ({ item, kind: "Pull request" as const })),
        ...issues.map((item) => ({ item, kind: "Issue" as const })),
      ]
        .filter(({ item }) => Date.parse(item.createdAt) > Date.parse(since))
        .filter(({ item, kind }) =>
          events.some((event) =>
            kind === "Issue"
              ? event === "issue.opened"
              : event !== "issue.opened" && githubItemMatches(event, item),
          ),
        )
        .toSorted((a, b) => a.item.createdAt.localeCompare(b.item.createdAt));

      const newest = [...pullRequests, ...issues]
        .map((item) => item.createdAt)
        .reduce(
          (latest, createdAt) => (Date.parse(createdAt) > Date.parse(latest) ? createdAt : latest),
          since,
        );
      if (newest !== since) {
        yield* patchAutomation(automation.id, (stored) => ({ ...stored, githubCursor: newest }));
      }

      for (const { item, kind } of fresh.slice(0, MAX_GITHUB_RUNS_PER_POLL)) {
        const label =
          kind === "Issue"
            ? AUTOMATION_GITHUB_EVENT_LABELS["issue.opened"]
            : AUTOMATION_GITHUB_EVENT_LABELS[
                item.isDraft ? "pull_request.draft_opened" : "pull_request.opened"
              ];
        yield* executeRun(
          automation,
          `${label}: #${item.number}`,
          `Triggered by GitHub ${kind.toLowerCase()} #${item.number}: ${item.title}\n${item.url}`,
          kind === "Pull request" ? item : null,
        );
      }
    }).pipe(
      Effect.catchCause((failure) =>
        Effect.logWarning("automation GitHub poll failed", {
          automationId: automation.id,
          cause: Cause.pretty(failure),
        }),
      ),
    );

  /** Per automation, so a poll skipped while its automation was busy stays due for the next tick. */
  const lastGitHubPollAt = new Map<string, number>();
  const githubTick = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const file = yield* SubscriptionRef.get(state);
    for (const automation of file.automations) {
      if (
        !automation.enabled ||
        busy.has(automation.id) ||
        !automation.triggers.some((trigger) => trigger.type === "github") ||
        now - (lastGitHubPollAt.get(automation.id) ?? -Infinity) < GITHUB_POLL_INTERVAL_MS
      ) {
        continue;
      }
      lastGitHubPollAt.set(automation.id, now);
      yield* inBackground(automation.id, pollGitHub(automation));
    }
  });

  const start = Effect.fn("AutomationService.start")(function* () {
    // Runs that ended while the server was down, checked once events are flowing.
    const recheckAll = SubscriptionRef.get(state).pipe(
      Effect.flatMap((file) =>
        Effect.forEach(
          file.automations.flatMap((automation) =>
            automation.pendingRuns.map((entry) => entry.threadId),
          ),
          recheck,
          { discard: true },
        ),
      ),
    );
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents.pipe(Stream.onStart(recheckAll)), (event) =>
        settlesRuns(event) ||
        (event.type === "turn-item.updated" && waitingOnBackground.has(event.threadId))
          ? recheck(event.threadId)
          : Effect.void,
      ).pipe(
        Effect.catchCause((failure) =>
          Effect.logWarning("automation event stream failed", { cause: Cause.pretty(failure) }),
        ),
      ),
    );
    yield* forkParked(
      Effect.all([scheduleTick, githubTick], { discard: true }).pipe(
        Effect.catchCause((failure) =>
          Effect.logWarning("automation tick failed", { cause: Cause.pretty(failure) }),
        ),
        Effect.repeat(Schedule.spaced(SCHEDULE_TICK)),
        Effect.asVoid,
      ),
    );
  });

  const buildStored = (
    config: AutomationConfig,
    base: Pick<StoredAutomation, "id" | "createdAt" | "runs" | "githubCursor" | "pendingRuns">,
    now: string,
  ): StoredAutomation => ({
    ...config,
    // Picked field by field: an update passes the whole stored record, whose old config must not win.
    id: base.id,
    createdAt: base.createdAt,
    runs: base.runs,
    githubCursor: base.githubCursor,
    // Turning the setting off also spares threads of runs still going.
    pendingRuns: config.deleteThreadWhenDone
      ? base.pendingRuns
      : base.pendingRuns.map((entry) => ({ ...entry, deleteThread: false })),
    updatedAt: now,
    // Editing restarts the schedule from now, so saving never replays a time that already passed.
    scheduleCursor: now,
  });

  return AutomationService.of({
    start,
    // Cursor bookkeeping leaves the public snapshot as it was; clients only hear about real changes.
    changes: SubscriptionRef.changes(state).pipe(Stream.map(toSnapshot), Stream.changes),
    create: (config) =>
      Effect.gen(function* () {
        const now = yield* nowIso;
        const stored = buildStored(
          config,
          {
            id: yield* newId,
            createdAt: now,
            runs: [],
            githubCursor: null,
            pendingRuns: [],
          },
          now,
        );
        yield* modify((file) =>
          Effect.succeed([undefined, { automations: [...file.automations, stored] }] as const),
        );
        return toPublic(stored);
      }),
    update: (id, config) =>
      Effect.gen(function* () {
        const now = yield* nowIso;
        return yield* modify((file) => {
          const existing = file.automations.find((entry) => entry.id === id);
          if (!existing) return failWith("Automation not found.");
          const stored = buildStored(config, existing, now);
          return Effect.succeed([
            toPublic(stored),
            {
              automations: file.automations.map((entry) => (entry.id === id ? stored : entry)),
            },
          ] as const);
        });
      }),
    remove: (id) =>
      modify((file) =>
        Effect.succeed([
          undefined,
          { automations: file.automations.filter((entry) => entry.id !== id) },
        ] as const),
      ),
    runNow: (id) =>
      findAutomation(id).pipe(
        Effect.flatMap((automation) => executeRun(automation, "Manual run", null, null)),
      ),
  });
});

export const layer = Layer.effect(AutomationService, make);
