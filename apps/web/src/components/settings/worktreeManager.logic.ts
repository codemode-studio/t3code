import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, VcsListedWorktree } from "@t3tools/contracts";

export interface WorktreeDeletionTarget {
  environmentId: EnvironmentId;
  cwd: string;
  worktree: VcsListedWorktree;
}

export function worktreeThreads<
  T extends Pick<EnvironmentThreadShell, "environmentId" | "projectId" | "worktreePath">,
>(
  threads: ReadonlyArray<T>,
  projects: ReadonlyArray<Pick<EnvironmentProject, "environmentId" | "id" | "workspaceRoot">>,
  environmentId: EnvironmentId,
) {
  const roots = new Map(
    projects
      .filter((project) => project.environmentId === environmentId)
      .map((project) => [project.id, project.workspaceRoot]),
  );
  const byPath = new Map<string, T[]>();
  for (const thread of threads) {
    if (thread.environmentId !== environmentId) continue;
    const path = thread.worktreePath ?? roots.get(thread.projectId);
    if (!path) continue;
    const entries = byPath.get(path);
    if (entries) entries.push(thread);
    else byPath.set(path, [thread]);
  }
  return byPath;
}

export function worktreeDeletionBlockReason(
  target: WorktreeDeletionTarget,
  member: { environmentId: EnvironmentId; workspaceRoot: string } | null,
  threads: ReadonlyArray<
    Pick<
      EnvironmentThreadShell,
      | "session"
      | "latestTurn"
      | "backgroundLiveness"
      | "hasPendingApprovals"
      | "hasPendingUserInput"
    >
  >,
): string | null {
  if (member?.environmentId !== target.environmentId || member.workspaceRoot !== target.cwd) {
    return "The selected checkout is no longer connected. Close this dialog and select it again.";
  }
  const tree = target.worktree;
  if (tree.locked) return "Locked in Git";
  if (tree.isMain || tree.path === target.cwd) return "Selected project checkout";
  if (!tree.branch) return "Detached worktree";
  if (
    threads.some(
      (thread) =>
        thread.session?.status === "running" ||
        thread.session?.status === "starting" ||
        thread.latestTurn?.state === "running" ||
        thread.backgroundLiveness != null ||
        thread.hasPendingApprovals ||
        thread.hasPendingUserInput,
    )
  )
    return "A thread is running here";
  return null;
}
