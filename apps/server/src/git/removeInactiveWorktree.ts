import {
  GitCommandError,
  type OrchestrationV2ThreadShell,
  type VcsRemoveWorktreeInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { threadHasQueuedTurnStart } from "../orchestration-v2/ThreadSettlementService.ts";
import { GitWorkflowService } from "./GitWorkflowService.ts";

const IDLE_STATUSES = new Set<OrchestrationV2ThreadShell["status"]>([
  "idle",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

/** A run requested, queued or underway, a pending prompt, or background work still owed. */
const isThreadBusy = (thread: OrchestrationV2ThreadShell, nowMs: number) =>
  !IDLE_STATUSES.has(thread.status) ||
  thread.activeRunId !== null ||
  thread.activityRunStatus != null ||
  thread.pendingRuntimeRequest !== null ||
  (thread.pendingBackgroundTasks?.length ?? 0) > 0 ||
  threadHasQueuedTurnStart(thread, nowMs);

/** Recheck host state at removal time, including work started by another client. */
export const removeInactiveWorktree = Effect.fn("removeInactiveWorktree")(function* (
  input: VcsRemoveWorktreeInput,
) {
  const threads = yield* ThreadManagementService;
  const projects = yield* ProjectStoreV2;
  const git = yield* GitWorkflowService;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const fail = (detail: string) =>
    new GitCommandError({
      operation: "vcs.removeWorktree",
      cwd: input.cwd,
      command: "git worktree remove",
      detail,
    });
  const [shell, projectRows] = yield* Effect.all([
    threads.getShellSnapshot(),
    projects.list({ includeDeleted: true }),
  ]).pipe(Effect.mapError(() => fail("Could not check whether this worktree is in use.")));
  const roots = new Map(projectRows.map((project) => [project.projectId, project.workspaceRoot]));
  const canonicalPaths = new Map<string, string>();
  const canonicalPath = Effect.fnUntraced(function* (value: string) {
    const cached = canonicalPaths.get(value);
    if (cached !== undefined) return cached;
    const canonical = yield* fs
      .realPath(value)
      .pipe(Effect.orElseSucceed(() => path.resolve(value)));
    canonicalPaths.set(value, canonical);
    return canonical;
  });
  const targetPath = yield* canonicalPath(path.resolve(input.cwd, input.path));
  const nowMs = yield* Clock.currentTimeMillis;
  const inUse = fail("A thread is running in this worktree. Stop it before deleting the worktree.");
  for (const thread of [...shell.threads, ...shell.archivedThreads]) {
    const cwd = thread.worktreePath ?? roots.get(thread.projectId);
    if (!cwd || (yield* canonicalPath(cwd)) !== targetPath) continue;
    if (isThreadBusy(thread, nowMs)) return yield* inUse;
    // The shell hides a queue that restart recovery holds until the user resumes it.
    const { runs } = yield* threads
      .getProjectThreadRecords({ projectId: thread.projectId, threadId: thread.id }, ["runs"])
      .pipe(Effect.mapError(() => fail("Could not check whether this worktree is in use.")));
    if (runs.some((run) => run.status === "queued")) return yield* inUse;
  }
  yield* git.removeWorktree(input);
});
