import { GitCommandError, type VcsRemoveWorktreeInput } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { threadHasQueuedTurnStart } from "../orchestration/ThreadSettlementPolicy.ts";
import { GitWorkflowService } from "./GitWorkflowService.ts";

/** Recheck host state at removal time, including work started by another client. */
export const removeInactiveWorktree = Effect.fn("removeInactiveWorktree")(function* (
  input: VcsRemoveWorktreeInput,
) {
  const snapshots = yield* ProjectionSnapshotQuery;
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
  const [active, archived] = yield* Effect.all([
    snapshots.getShellSnapshot(),
    snapshots.getArchivedShellSnapshot(),
  ]).pipe(Effect.mapError(() => fail("Could not check whether this worktree is in use.")));
  const roots = new Map(
    [...active.projects, ...archived.projects].map((project) => [
      project.id,
      project.workspaceRoot,
    ]),
  );
  const canonicalPath = (value: string) =>
    fs.realPath(value).pipe(Effect.orElseSucceed(() => path.resolve(value)));
  const targetPath = yield* canonicalPath(path.resolve(input.cwd, input.path));
  const now = DateTime.formatIso(yield* DateTime.now);
  for (const thread of [...active.threads, ...archived.threads]) {
    const busy =
      thread.session?.status === "running" ||
      thread.session?.status === "starting" ||
      thread.latestTurn?.state === "running" ||
      thread.backgroundLiveness != null ||
      thread.hasPendingApprovals ||
      thread.hasPendingUserInput ||
      threadHasQueuedTurnStart(thread, now);
    if (!busy) continue;
    const cwd = thread.worktreePath ?? roots.get(thread.projectId);
    if (!cwd || (yield* canonicalPath(cwd)) !== targetPath) continue;
    return yield* fail(
      "A thread is running in this worktree. Stop it before deleting the worktree.",
    );
  }
  yield* git.removeWorktree(input);
});
