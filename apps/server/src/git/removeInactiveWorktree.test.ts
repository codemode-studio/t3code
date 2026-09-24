import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { GitWorkflowService } from "./GitWorkflowService.ts";
import { removeInactiveWorktree } from "./removeInactiveWorktree.ts";

const projectId = ProjectId.make("linked-project");
const updatedAt = "2026-09-01T00:00:00.000Z";
const input = { cwd: "/repo", path: "/linked", force: true };
function thread(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: ThreadId.make("thread"),
    projectId,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    pullRequests: [],
    branch: "feature",
    worktreePath: null,
    latestTurn: null,
    createdAt: updatedAt,
    updatedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}
function snapshot(threads: ReadonlyArray<OrchestrationThreadShell>): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 1,
    updatedAt,
    threads,
    projects: [
      {
        id: projectId,
        title: "Linked",
        workspaceRoot: "/linked",
        defaultModelSelection: null,
        scripts: [],
        createdAt: updatedAt,
        updatedAt,
      },
    ],
  };
}
function setup(
  initial: OrchestrationThreadShell[] = [],
  archived: OrchestrationThreadShell[] = [],
) {
  let current = initial;
  let snapshotFailed = false;
  const removed: string[] = [];
  const layer = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getShellSnapshot: () =>
        Effect.suspend(() =>
          snapshotFailed
            ? Effect.fail(new PersistenceSqlError({ operation: "snapshot" }))
            : Effect.succeed(snapshot(current)),
        ),
      getArchivedShellSnapshot: () => Effect.succeed(snapshot(archived)),
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
    setThreads: (threads: OrchestrationThreadShell[]) => {
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
      state.setThreads([thread({ latestUserMessageAt: DateTime.formatIso(yield* DateTime.now) })]);
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
        thread({
          session: {
            threadId: ThreadId.make("thread"),
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt,
          },
        }),
      ]);
      const result = yield* removeInactiveWorktree(input).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (Result.isFailure(result)) assert.include(result.failure.message, "A thread is running");
      assert.deepEqual(state.removed, ["/linked"]);
    }).pipe(Effect.provide(state.layer));
  });

  for (const archived of [false, true]) {
    it.effect(`protects active project-root threads${archived ? " in the archive" : ""}`, () => {
      const active = thread({ backgroundLiveness: "working" });
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
    const state = setup([thread({ worktreePath: "/other", backgroundLiveness: "working" })]);
    return Effect.gen(function* () {
      yield* removeInactiveWorktree(input);
      state.setThreads([thread({ worktreePath: "/linked", hasPendingUserInput: true })]);
      const result = yield* removeInactiveWorktree(input).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.deepEqual(state.removed, ["/linked"]);
    }).pipe(Effect.provide(state.layer));
  });
});
