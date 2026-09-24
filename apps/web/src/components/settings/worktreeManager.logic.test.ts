import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  worktreeDeletionBlockReason,
  worktreeThreads,
  type WorktreeDeletionTarget,
} from "./worktreeManager.logic";

const laptop = EnvironmentId.make("laptop");
const server = EnvironmentId.make("server");
const projectId = ProjectId.make("linked");
const target: WorktreeDeletionTarget = {
  environmentId: laptop,
  cwd: "/repo",
  worktree: {
    path: "/linked",
    branch: "feature",
    head: "abc",
    isMain: false,
    locked: false,
    prunable: false,
  },
};
const member = { environmentId: laptop, workspaceRoot: "/repo" };
const idle = {
  session: null,
  latestTurn: null,
  backgroundLiveness: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
};

describe("worktree deletion", () => {
  it("counts local threads in a registered linked checkout, scoped to its environment", () => {
    const local = {
      ...idle,
      id: ThreadId.make("local"),
      environmentId: laptop,
      projectId,
      worktreePath: null,
      backgroundLiveness: "working" as const,
    };
    const explicit = { ...local, id: ThreadId.make("explicit"), worktreePath: "/linked" };
    const otherMachine = { ...local, environmentId: server };
    const grouped = worktreeThreads(
      [local, explicit, otherMachine],
      [
        { environmentId: laptop, id: projectId, workspaceRoot: "/linked" },
        { environmentId: server, id: projectId, workspaceRoot: "/elsewhere" },
      ],
      laptop,
    );
    expect(grouped.get("/linked")).toEqual([local, explicit]);
    expect(worktreeDeletionBlockReason(target, member, grouped.get("/linked")!)).toBe(
      "A thread is running here",
    );
  });

  it("blocks an open confirmation when its machine disconnects or the checkout changes", () => {
    expect(worktreeDeletionBlockReason(target, member, [])).toBeNull();
    expect(
      worktreeDeletionBlockReason(target, { ...member, environmentId: server }, []),
    ).not.toBeNull();
    expect(
      worktreeDeletionBlockReason(target, { ...member, workspaceRoot: "/other" }, []),
    ).not.toBeNull();
    expect(worktreeDeletionBlockReason(target, null, [])).not.toBeNull();
  });

  it("rechecks activity for an already selected deletion target", () => {
    expect(worktreeDeletionBlockReason(target, member, [idle])).toBeNull();
    expect(
      worktreeDeletionBlockReason(target, member, [{ ...idle, backgroundLiveness: "working" }]),
    ).toBe("A thread is running here");
    expect(
      worktreeDeletionBlockReason(target, member, [{ ...idle, hasPendingApprovals: true }]),
    ).toBe("A thread is running here");
  });
});
