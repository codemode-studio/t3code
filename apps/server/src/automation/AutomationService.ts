/**
 * Automations: saved prompts that start agent turns on a schedule or when GitHub activity lands.
 *
 * The records live in `automations.json` in the state directory. A run creates a thread in the
 * automation's project (in a fresh worktree or the project checkout) and starts a turn with the
 * automation's instructions, the same way a user sending a first message would. Once that turn
 * ends, the agent's last message is saved on the run as its summary, later replaced by one the
 * text generation model writes, and with `deleteThreadWhenDone`, the run's thread is deleted.
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
  type OrchestrationLatestTurnState,
  type OrchestrationThreadShell,
  ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import {
  AUTOMATION_GITHUB_EVENT_LABELS,
  describeTrigger,
  latestTriggerAt,
} from "@t3tools/shared/automationSchedule";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
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
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionThreadMessageRepository } from "../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "../orchestration/Services/ThreadDeletionReactor.ts";
import { threadHasQueuedTurnStart } from "../orchestration/ThreadSettlementPolicy.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { RUN_SUMMARY_TRANSCRIPT_MAX_LENGTH } from "../textGeneration/TextGenerationPrompts.ts";

/** A run whose turn has not ended yet; `messageAt` is when the run's message was sent. */
const PendingRun = Schema.Struct({
  /** Absent, with `messageId`, on entries saved before runs kept summaries. */
  runId: Schema.optional(Schema.String),
  threadId: ThreadId,
  /** The run's message, which identifies the turn it starts. */
  messageId: Schema.optional(MessageId),
  messageAt: IsoDateTime,
  /** Defaults on for those older entries, which were all thread deletes. */
  deleteThread: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
type PendingRun = typeof PendingRun.Type;

/**
 * What the file keeps beyond the public record: how far each trigger source has been read, and
 * which runs still wait for their turn to end.
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
const SETUP_SCRIPT_WAIT = Duration.minutes(15);
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

/** Several only in a continued conversation, where each run sends another turn to one thread. */
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

/**
 * What to do once a run's turn ends: delete its thread when the turn completed and the run asked
 * for that, or keep it, also when the turn errored or was stopped so the user can see why, or when
 * the user wrote in it. Waits while work remains. `turn` is the turn the run's message started.
 */
function runThreadOutcome(
  thread: OrchestrationThreadShell,
  pending: PendingRun,
  turn: { readonly state: OrchestrationLatestTurnState | "pending" } | null,
  now: string,
): "delete" | "keep" | "wait" {
  if (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    thread.backgroundLiveness != null ||
    threadHasQueuedTurnStart(thread, now)
  ) {
    return "wait";
  }
  switch (turn?.state) {
    case "completed": {
      // Server-stamped, so a later message is the user's, not the run's.
      const userWrote =
        thread.latestUserMessageAt !== null &&
        Date.parse(thread.latestUserMessageAt) > Date.parse(pending.messageAt);
      return pending.deleteThread && !userWrote ? "delete" : "keep";
    }
    case "error":
    case "interrupted":
      return "keep";
    case "running":
    case "pending":
      return "wait";
    default:
      // Idle, with nothing queued, and the message never started a turn of its own: it was
      // dropped, or it steered a turn that was already running and is summarized with that one.
      return "keep";
  }
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

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const setupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const gitHubCli = yield* GitHubCli.GitHubCli;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const turnRepository = yield* ProjectionTurnRepository;
  const messageRepository = yield* ProjectionThreadMessageRepository;

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
        const project = yield* snapshotQuery
          .getProjectShellById(automation.projectId)
          .pipe(Effect.map(Option.getOrUndefined));
        if (project === undefined) return;
        const { textGenerationModelSelection } = resolveProjectSettings(
          yield* settingsService.getSettings,
          project.id,
          project,
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
   * Settles a thread's pending runs whose turn ended: saves their summaries and deletes the thread
   * when a run asked for that. Safe to call at any time; one call at a time. The delete is guarded
   * by the projection sequence read before the thread, so the engine rejects it if anything, such
   * as a new user message, reached the thread after that read.
   */
  const settleRunThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const pending = pendingRunsOf(yield* SubscriptionRef.get(state), threadId);
      if (pending.length === 0) return;
      const { snapshotSequence } = yield* snapshotQuery.getSnapshotSequence();
      const thread = yield* snapshotQuery
        .getThreadShellById(threadId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (thread === undefined) {
        // Deleted some other way, e.g. by the user.
        return yield* recordPendingRuns(threadId, [], "deleted");
      }
      const now = yield* nowIso;
      const ended: Array<{
        readonly entry: PendingRun;
        readonly outcome: "delete" | "keep";
        readonly turnId: TurnId | null;
      }> = [];
      for (const entry of pending) {
        // Entries from before message ids were kept all belong to fresh threads, whose latest
        // turn is the run's.
        const turn =
          entry.messageId === undefined
            ? thread.latestTurn
            : Option.getOrNull(
                yield* turnRepository.getByPendingMessageId({
                  threadId,
                  messageId: entry.messageId,
                }),
              );
        const outcome = runThreadOutcome(thread, entry, turn, now);
        if (outcome !== "wait") ended.push({ entry, outcome, turnId: turn?.turnId ?? null });
      }
      if (ended.length === 0) return;
      const finished: Array<{
        readonly entry: PendingRun;
        readonly agentMessages: ReadonlyArray<string>;
        readonly summary: string | undefined;
      }> = [];
      for (const { entry, turnId } of ended) {
        const agentMessages =
          turnId === null
            ? []
            : (yield* messageRepository.listAssistantTextsByTurn({ threadId, turnId }))
                .map((text) => text.trim())
                .filter((text) => text !== "");
        const last = agentMessages.at(-1);
        finished.push({
          entry,
          agentMessages,
          summary: last === undefined ? undefined : capSummary(last),
        });
      }
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
      const deleted = yield* engine
        .dispatch({
          type: "thread.auto-delete",
          commandId: CommandId.make(`server:automation-thread-delete:${yield* newId}`),
          threadId,
          snapshotSequence,
        })
        .pipe(
          Effect.as(true),
          Effect.catchTag("OrchestrationCommandInvariantError", () => Effect.succeed(false)),
        );
      // The thread changed after the read, and not every change is an event cleanup watches,
      // so check again against a fresh read.
      if (!deleted) return yield* recheck(threadId);
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

  // Off the event stream, so a slow lookup or dispatch never holds up the engine's subscribers.
  // A thread already queued is not queued again; it is dequeued before it is read, so an event
  // arriving during a check still queues the next one.
  const queued = new Set<ThreadId>();
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

  /** Creates the thread (and worktree) a fresh run works in. */
  const createRunThread = Effect.fn("AutomationService.createRunThread")(function* (
    automation: StoredAutomation,
    workspaceRoot: string,
    modelSelection: NonNullable<AutomationConfig["modelSelection"]>,
    pullRequest: GitHubItem | null,
  ) {
    const threadId = ThreadId.make(yield* newId);
    let branch: string | null = null;
    let worktreePath: string | null = null;
    const inWorktree =
      automation.workingCopy === "worktree" && (yield* gitWorkflow.isRepository(workspaceRoot));
    if (inWorktree && pullRequest !== null) {
      worktreePath = yield* createPullRequestWorktree(workspaceRoot, pullRequest.number);
    } else if (inWorktree) {
      const status = yield* gitWorkflow.localStatus({ cwd: workspaceRoot });
      const baseBranch = status.refName;
      if (baseBranch === null) {
        return yield* failWith("The project checkout is not on a branch to start a worktree from.");
      }
      const created = yield* gitWorkflow.createWorktree({
        cwd: workspaceRoot,
        refName: baseBranch,
        newRefName: buildTemporaryWorktreeBranchName((bytes) =>
          NodeCrypto.randomBytes(bytes).toString("hex"),
        ),
        baseRefName: baseBranch,
        path: null,
      });
      branch = created.worktree.refName;
      worktreePath = created.worktree.path;
    }

    const createdAt = yield* nowIso;
    const created = yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`server:automation-thread-create:${yield* newId}`),
      threadId,
      projectId: automation.projectId,
      title: automation.name,
      modelSelection,
      runtimeMode: automation.runtimeMode,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch,
      worktreePath,
      createdAt,
    });
    yield* threadDeletionReactor.drainThrough(created.sequence);

    if (worktreePath !== null) {
      // Best effort, like the chat bootstrap: a failed install must not throw away the run.
      // A blocking (non-async) setup script is waited on so the agent starts with dependencies.
      const setup = yield* setupScriptRunner
        .runForThread({
          threadId,
          projectId: automation.projectId,
          projectCwd: workspaceRoot,
          worktreePath,
          observeCompletion: {},
        })
        .pipe(Effect.option);
      if (Option.isSome(setup) && setup.value.status === "started" && !setup.value.async) {
        yield* (setup.value.completion ?? Effect.void).pipe(
          Effect.timeout(SETUP_SCRIPT_WAIT),
          Effect.ignore,
        );
      }
    }
    return { threadId, detachedAtPullRequest: pullRequest !== null && worktreePath !== null };
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
      const project = yield* snapshotQuery
        .getProjectShellById(automation.projectId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (!project) {
        return yield* failWith("The automation's project no longer exists.");
      }
      const settings = yield* settingsService.getSettings;
      const projectSettings = resolveProjectSettings(settings, project.id, project).settings;
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
        ? yield* snapshotQuery
            .getThreadShellById(previousThreadId)
            .pipe(Effect.map(Option.getOrUndefined))
        : undefined;
      const continued =
        previousThread !== undefined && previousThread.archivedAt === null
          ? previousThread
          : undefined;
      // One run at a time per thread: a second message before the first starts its turn would
      // steer or replace it, leaving neither run its own turn to settle and summarize.
      if (
        continued !== undefined &&
        pendingRunsOf(yield* SubscriptionRef.get(state), continued.id).length > 0
      ) {
        return yield* failWith(
          "The previous run is still going or waiting for you in the same thread.",
        );
      }
      const run =
        continued !== undefined
          ? { threadId: continued.id, detachedAtPullRequest: false }
          : yield* createRunThread(automation, project.workspaceRoot, modelSelection, pullRequest);
      const threadId = run.threadId;

      const link = pullRequest === null ? null : parseChangeRequestUrl(pullRequest.url);
      if (pullRequest !== null && link !== null) {
        yield* engine
          .dispatch({
            type: "thread.pull-request.link",
            commandId: CommandId.make(`server:automation-pr-link:${yield* newId}`),
            threadId,
            ...link,
            url: pullRequest.url,
            source: "manual",
          })
          .pipe(
            // Already linked (a continued conversation reviewing it again) is the goal state.
            Effect.catchTags({ OrchestrationCommandInvariantError: () => Effect.void }),
            Effect.ignoreCause({ log: true }),
          );
      }
      const runContext =
        pullRequest !== null && run.detachedAtPullRequest
          ? `${context ?? ""}\nThis worktree is checked out detached at the pull request's head. To review newer commits, run \`gh pr checkout ${pullRequest.number} --detach\`.`
          : context;

      const createdAt = yield* nowIso;
      const messageId = MessageId.make(yield* newId);
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`server:automation-turn-start:${yield* newId}`),
        threadId,
        message: {
          messageId,
          role: "user",
          text: runContext ? `${automation.prompt}\n\n---\n${runContext}` : automation.prompt,
          attachments: [],
        },
        modelSelection,
        titleSeed: automation.name,
        runtimeMode: automation.runtimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt,
      });
      return { threadId, messageId, messageAt: createdAt };
    }).pipe(
      Effect.map(({ threadId, messageId, messageAt }) => ({
        threadId,
        messageId,
        messageAt,
        error: null,
      })),
      Effect.catchCause((failure) =>
        Effect.logWarning("automation run failed", {
          automationId: automation.id,
          cause: Cause.pretty(failure),
        }).pipe(
          Effect.as({
            threadId: null,
            messageId: null,
            messageAt: null,
            error:
              Cause.squash(failure) instanceof Error
                ? (Cause.squash(failure) as Error).message
                : "The run failed to start.",
          }),
        ),
      ),
      Effect.flatMap(({ threadId, messageId, messageAt, error }) =>
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
          // The turn may have finished before its run was recorded. Queued, so the automation is
          // free for its next trigger without waiting on the check.
          if (threadId !== null) yield* recheck(threadId);
          return run;
        }),
      ),
    );

  /**
   * Automations with a run starting or a GitHub poll going. That work runs off the tick loop, so
   * a slow setup script or `gh` call holds up only its own automation, which ticks skip until it
   * is done. A skipped due time still starts afterwards if it is within the catch-up window.
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
      const project = yield* snapshotQuery
        .getProjectShellById(automation.projectId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (!project) return;
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
    // Turns that finished while the server was down, checked once events are flowing.
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
      Stream.runForEach(engine.streamDomainEvents.pipe(Stream.onStart(recheckAll)), (event) =>
        // Session and checkpoint events end a turn; activities resolve requests and end
        // background tasks, which can outlast both.
        event.type === "thread.session-set" ||
        event.type === "thread.turn-diff-completed" ||
        event.type === "thread.activity-appended" ||
        event.type === "thread.deleted"
          ? recheck(event.payload.threadId)
          : Effect.void,
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
