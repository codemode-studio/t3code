import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ProviderProfileId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  countAttentionByProfile,
  threadNeedsAttention,
  type AttentionThread,
} from "./profileScope.logic";

const environmentId = EnvironmentId.make("env-1");
const acmeProject = ProjectId.make("project-acme");
const looseProject = ProjectId.make("project-loose");
const acme = ProviderProfileId.make("acme");

function thread(overrides: Partial<AttentionThread> = {}): AttentionThread {
  return {
    id: ThreadId.make("thread-1"),
    environmentId,
    projectId: acmeProject,
    archivedAt: null,
    settledOverride: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    interactionMode: "default",
    runtime: null,
    latestRun: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    ...overrides,
  };
}

const completed = {
  runId: RunId.make("run-1"),
  status: "completed",
  requestedAt: "2026-09-01T10:00:00.000Z",
  startedAt: "2026-09-01T10:00:00.000Z",
  completedAt: "2026-09-01T10:05:00.000Z",
  assistantMessageId: null,
} as const satisfies AttentionThread["latestRun"];

describe("threadNeedsAttention", () => {
  it("counts approvals, questions and unread completions, not idle or settled work", () => {
    expect(threadNeedsAttention(thread({ hasPendingApprovals: true }), undefined)).toBe(true);
    expect(threadNeedsAttention(thread({ hasPendingUserInput: true }), undefined)).toBe(true);
    expect(threadNeedsAttention(thread({ latestRun: completed }), "2026-09-01T09:00:00.000Z")).toBe(
      true,
    );
    // Seen after it finished, never visited, and settled threads wait on nobody.
    expect(threadNeedsAttention(thread({ latestRun: completed }), "2026-09-01T11:00:00.000Z")).toBe(
      false,
    );
    expect(threadNeedsAttention(thread({ latestRun: completed }), undefined)).toBe(false);
    expect(
      threadNeedsAttention(
        thread({ hasPendingApprovals: true, settledOverride: "settled" }),
        undefined,
      ),
    ).toBe(false);
  });

  it("prefers the server's visited watermark over the local one", () => {
    expect(
      threadNeedsAttention(
        thread({ latestRun: completed, lastVisitedAt: "2026-09-01T11:00:00.000Z" }),
        "2026-09-01T09:00:00.000Z",
      ),
    ).toBe(false);
  });
});

describe("countAttentionByProfile", () => {
  it("counts a waiting parent or fork but never its subagents", () => {
    const childOf = (relationshipToParent: "fork" | "subagent") => ({
      rootThreadId: ThreadId.make("parent"),
      parentThreadId: ThreadId.make("parent"),
      relationshipToParent,
    });
    const failed = {
      status: "failed",
      activeRunId: null,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: null,
      lastError: "boom",
      updatedAt: "2026-09-01T10:05:00.000Z",
    } as const;
    const counts = countAttentionByProfile({
      threads: [
        thread({ id: ThreadId.make("parent"), hasPendingApprovals: true }),
        thread({ id: ThreadId.make("fork"), runtime: failed, lineage: childOf("fork") }),
        thread({
          id: ThreadId.make("subagent-approval"),
          hasPendingApprovals: true,
          lineage: childOf("subagent"),
        }),
        thread({
          id: ThreadId.make("subagent-failed"),
          runtime: failed,
          lineage: childOf("subagent"),
        }),
        thread({
          id: ThreadId.make("subagent-unread"),
          latestRun: completed,
          lastVisitedAt: "2026-09-01T09:00:00.000Z",
          lineage: childOf("subagent"),
        }),
      ],
      projectProfiles: new Map([[`${environmentId}:${acmeProject}`, acme]]),
      lastVisitedAtByThreadKey: {},
      threadKey: (entry) => `${entry.environmentId}:${entry.id}`,
    });
    expect(counts.get(acme)).toBe(2);
  });

  it("groups waiting threads by their project's profile, with null for no profile", () => {
    const counts = countAttentionByProfile({
      threads: [
        thread({ id: ThreadId.make("a"), hasPendingApprovals: true }),
        thread({ id: ThreadId.make("b"), hasPendingUserInput: true }),
        thread({ id: ThreadId.make("c"), projectId: looseProject, hasPendingApprovals: true }),
        thread({ id: ThreadId.make("d") }),
      ],
      projectProfiles: new Map([
        [`${environmentId}:${acmeProject}`, acme],
        [`${environmentId}:${looseProject}`, null],
      ]),
      lastVisitedAtByThreadKey: {},
      threadKey: (entry) => `${entry.environmentId}:${entry.id}`,
    });
    expect(counts.get(acme)).toBe(2);
    expect(counts.get(null)).toBe(1);
  });
});
