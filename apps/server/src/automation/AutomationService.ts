/**
 * Automations: saved prompts that start agent turns on a schedule or when GitHub activity lands.
 *
 * The records live in `automations.json` in the state directory. A run creates a thread in the
 * automation's project (in a fresh worktree or the project checkout) and starts a turn with the
 * automation's instructions, the same way a user sending a first message would.
 *
 * @module AutomationService
 */
import * as NodeCrypto from "node:crypto";

import {
  Automation,
  AUTOMATION_MAX_RUNS,
  AutomationError,
  type AutomationConfig,
  type AutomationGitHubEvent,
  type AutomationRun,
  type AutomationsSnapshot,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  IsoDateTime,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import {
  AUTOMATION_GITHUB_EVENT_LABELS,
  describeTrigger,
  latestTriggerAt,
} from "@t3tools/shared/automationSchedule";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
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
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "../orchestration/Services/ThreadDeletionReactor.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";

/** What the file keeps beyond the public record: how far each trigger source has been read. */
const StoredAutomation = Schema.Struct({
  ...Automation.fields,
  /** Scheduled times at or before this instant have been handled. */
  scheduleCursor: IsoDateTime,
  /** GitHub items created at or before this instant have been handled; null until first poll. */
  githubCursor: Schema.NullOr(IsoDateTime),
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
  const { scheduleCursor: _scheduleCursor, githubCursor: _githubCursor, ...automation } = stored;
  return automation;
}

function toSnapshot(file: AutomationsFile): AutomationsSnapshot {
  return { automations: file.automations.map(toPublic) };
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

  /** Creates the thread (and worktree) a fresh run works in. */
  const createRunThread = Effect.fn("AutomationService.createRunThread")(function* (
    automation: StoredAutomation,
    workspaceRoot: string,
    modelSelection: NonNullable<AutomationConfig["modelSelection"]>,
  ) {
    const threadId = ThreadId.make(yield* newId);
    let branch: string | null = null;
    let worktreePath: string | null = null;
    if (automation.workingCopy === "worktree" && (yield* gitWorkflow.isRepository(workspaceRoot))) {
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
    return threadId;
  });

  /** Starts one run and records it. Never fails: a failed run is a run with an error. */
  const executeRun = (automation: StoredAutomation, cause: string, context: string | null) =>
    Effect.gen(function* () {
      const project = yield* snapshotQuery
        .getProjectShellById(automation.projectId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (!project) {
        return yield* failWith("The automation's project no longer exists.");
      }
      const settings = yield* settingsService.getSettings;
      const modelSelection =
        automation.modelSelection ??
        resolveProjectSettings(settings, project.id, project).settings.defaultModelSelection ??
        settings.defaultModelSelection;
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
      const threadId =
        previousThread && previousThread.archivedAt === null
          ? previousThread.id
          : yield* createRunThread(automation, project.workspaceRoot, modelSelection);

      const createdAt = yield* nowIso;
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`server:automation-turn-start:${yield* newId}`),
        threadId,
        message: {
          messageId: MessageId.make(yield* newId),
          role: "user",
          text: context ? `${automation.prompt}\n\n---\n${context}` : automation.prompt,
          attachments: [],
        },
        modelSelection,
        titleSeed: automation.name,
        runtimeMode: automation.runtimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt,
      });
      return threadId;
    }).pipe(
      Effect.map((threadId) => ({ threadId, error: null })),
      Effect.catchCause((failure) =>
        Effect.logWarning("automation run failed", {
          automationId: automation.id,
          cause: Cause.pretty(failure),
        }).pipe(
          Effect.as({
            threadId: null,
            error:
              Cause.squash(failure) instanceof Error
                ? (Cause.squash(failure) as Error).message
                : "The run failed to start.",
          }),
        ),
      ),
      Effect.flatMap(({ threadId, error }) =>
        Effect.gen(function* () {
          const run: AutomationRun = {
            id: yield* newId,
            startedAt: yield* nowIso,
            cause,
            threadId,
            error,
          };
          yield* patchAutomation(automation.id, (stored) => ({
            ...stored,
            runs: [run, ...stored.runs].slice(0, AUTOMATION_MAX_RUNS),
          })).pipe(Effect.ignoreCause({ log: true }));
          return run;
        }),
      ),
    );

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
      yield* patchAutomation(automation.id, (stored) => ({ ...stored, scheduleCursor: nowText }));
      // Two schedules due in the same tick are one run, not two copies of the same work.
      const [first] = due;
      if (first) {
        yield* executeRun(automation, describeTrigger(first), null);
      }
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
      yield* patchAutomation(automation.id, (stored) => ({ ...stored, githubCursor: newest }));

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

  let lastGitHubPollAt = 0;
  const githubTick = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (now - lastGitHubPollAt < GITHUB_POLL_INTERVAL_MS) return;
    lastGitHubPollAt = now;
    const file = yield* SubscriptionRef.get(state);
    yield* Effect.forEach(
      file.automations.filter((automation) => automation.enabled),
      pollGitHub,
      { discard: true },
    );
  });

  const start = Effect.fn("AutomationService.start")(function* () {
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
    base: Pick<StoredAutomation, "id" | "createdAt" | "runs" | "githubCursor">,
    now: string,
  ): StoredAutomation => ({
    ...config,
    ...base,
    updatedAt: now,
    // Editing restarts the schedule from now, so saving never replays a time that already passed.
    scheduleCursor: now,
  });

  return AutomationService.of({
    start,
    changes: SubscriptionRef.changes(state).pipe(Stream.map(toSnapshot)),
    create: (config) =>
      Effect.gen(function* () {
        const now = yield* nowIso;
        const stored = buildStored(
          config,
          { id: yield* newId, createdAt: now, runs: [], githubCursor: null },
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
        Effect.flatMap((automation) => executeRun(automation, "Manual run", null)),
      ),
  });
});

export const layer = Layer.effect(AutomationService, make);
