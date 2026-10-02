import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { GitWorkflowService } from "./GitWorkflowService.ts";
import { removeInactiveWorktree } from "./removeInactiveWorktree.ts";

const projectId = ProjectId.make("linked-project");
const updatedAt = "2026-09-01T00:00:00.000Z";
const input = { cwd: "/repo", path: "/linked", force: true };
function thread(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  const at = DateTime.makeUnsafe(updatedAt);
  return {
    id: ThreadId.make("thread"),
    projectId,
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: "feature",
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}
function setup(
  initial: OrchestrationV2ThreadShell[] = [],
  archived: OrchestrationV2ThreadShell[] = [],
) {
  let current = initial;
  let snapshotFailed = false;
  const removed: string[] = [];
  const layer = Layer.mergeAll(
    Layer.mock(ThreadManagementService)({
      getShellSnapshot: () =>
        Effect.suspend(() =>
          snapshotFailed
            ? Effect.fail(new OrchestratorProjectionError({ threadId: ThreadId.make("thread") }))
            : Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 1,
                threads: current,
                archivedThreads: archived,
              }),
        ),
    }),
    Layer.mock(ProjectStoreV2)({
      list: () =>
        Effect.succeed([
          {
            projectId,
            title: "Linked",
            workspaceRoot: "/linked",
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: null,
            projectIcon: null,
            scripts: [],
            createdAt: updatedAt,
            updatedAt,
            deletedAt: null,
          },
        ]),
    }),
    Layer.mock(GitWorkflowService)({
      removeWorktree: (request) =>
        Effect.sync(() => {
          removed.push(request.path);
        }),
    }),
    FileSystem.layerNoop({
      realPath: (path) => Effect.succeed(path === "/alias" ? "/linked" : path),
    }),
    Path.layer,
  );
  return {
    layer,
    removed,
    failSnapshot: () => {
      snapshotFailed = true;
    },
    setThreads: (threads: OrchestrationV2ThreadShell[]) => {
      current = threads;
    },
  };
}

describe("removeInactiveWorktree", () => {
  it.effect("keeps the worktree when activity cannot be read", () => {
    const state = setup();
    state.failSnapshot();
    return Effect.gen(function* () {
      const result = yield* removeInactiveWorktree(input).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (Result.isFailure(result)) assert.include(result.failure.message, "Could not check");
      assert.deepEqual(state.removed, []);
    }).pipe(Effect.provide(state.layer));
  });

  it.effect("protects a queued turn before its provider reports running", () => {
    const state = setup();
    return Effect.gen(function* () {
      state.setThreads([thread({ latestUserMessageAt: yield* DateTime.now })]);
      const result = yield* removeInactiveWorktree({ ...input, path: "../linked" }).pipe(
        Effect.result,
      );
      assert.equal(result._tag, "Failure");
      assert.deepEqual(state.removed, []);
    }).pipe(Effect.provide(state.layer));
  });

  it.effect("checks current activity again for every removal request", () => {
    const state = setup([thread()]);
    return Effect.gen(function* () {
      yield* removeInactiveWorktree(input);
      state.setThreads([
        thread({ status: "running", activeRunId: RunId.make("run"), activityRunStatus: "running" }),
      ]);
      const result = yield* removeInactiveWorktree(input).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (Result.isFailure(result)) assert.include(result.failure.message, "A thread is running");
      assert.deepEqual(state.removed, ["/linked"]);
    }).pipe(Effect.provide(state.layer));
  });

  for (const archived of [false, true]) {
    it.effect(`protects active project-root threads${archived ? " in the archive" : ""}`, () => {
      const active = thread({
        pendingBackgroundTasks: [{ taskId: "task", kind: "command" }],
      });
      const state = setup(archived ? [] : [active], archived ? [active] : []);
      return Effect.gen(function* () {
        const result = yield* removeInactiveWorktree({ ...input, path: "/alias" }).pipe(
          Effect.result,
        );
        assert.equal(result._tag, "Failure");
        assert.deepEqual(state.removed, []);
      }).pipe(Effect.provide(state.layer));
    });
  }

  it.effect("protects explicit worktree threads and lets unrelated activity continue", () => {
    const state = setup([
      thread({ worktreePath: "/other", status: "running", activityRunStatus: "running" }),
    ]);
    return Effect.gen(function* () {
      yield* removeInactiveWorktree(input);
      state.setThreads([
        thread({ worktreePath: "/linked", status: "waiting", activityRunStatus: "waiting" }),
      ]);
      const result = yield* removeInactiveWorktree(input).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.deepEqual(state.removed, ["/linked"]);
    }).pipe(Effect.provide(state.layer));
  });
});
