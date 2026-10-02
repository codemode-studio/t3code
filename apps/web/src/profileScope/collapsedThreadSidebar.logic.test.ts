import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { partitionRailThreads, type RailThread } from "./collapsedThreadSidebar.logic";

const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-1");

function thread(id: string, overrides: Partial<RailThread> = {}): RailThread {
  return {
    id: ThreadId.make(id),
    environmentId,
    projectId,
    createdAt: "2026-09-01T08:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    latestUserMessageAt: null,
    runtime: null,
    latestRun: null,
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
    ...overrides,
  };
}

function childOf(parent: string, relationshipToParent: "fork" | "subagent") {
  return {
    rootThreadId: ThreadId.make(parent),
    parentThreadId: ThreadId.make(parent),
    relationshipToParent,
  };
}

describe("partitionRailThreads", () => {
  // Snooze times are UTC; run where local time differs so a zone-less "now" would misread them.
  let previousTimeZone: string | undefined;
  beforeAll(() => {
    previousTimeZone = process.env.TZ;
    process.env.TZ = "America/Sao_Paulo";
  });
  afterAll(() => {
    if (previousTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimeZone;
  });

  const now = new Date("2026-09-01T12:00:00.000Z");

  it("leaves subagents to their parent's Agents panel but keeps forks", () => {
    const result = partitionRailThreads({
      threads: [
        thread("parent", { pinnedAt: "2026-09-01T09:00:00.000Z" }),
        thread("pinned-subagent", {
          pinnedAt: "2026-09-01T09:30:00.000Z",
          lineage: childOf("parent", "subagent"),
        }),
        thread("subagent", { lineage: childOf("parent", "subagent") }),
        thread("fork", { lineage: childOf("parent", "fork") }),
      ],
      scopedProjectKeys: null,
      now,
    });
    expect(result.pinned.map((entry) => entry.id)).toEqual(["parent"]);
    expect(result.active.map((entry) => entry.id)).toEqual(["fork"]);
  });

  it("keeps a thread snoozed until its UTC wake time outside UTC", () => {
    const result = partitionRailThreads({
      threads: [
        thread("still-snoozed", {
          snoozedAt: "2026-09-01T11:00:00.000Z",
          snoozedUntil: "2026-09-01T13:00:00.000Z",
        }),
        thread("woke", {
          snoozedAt: "2026-09-01T10:00:00.000Z",
          snoozedUntil: "2026-09-01T11:00:00.000Z",
        }),
      ],
      scopedProjectKeys: null,
      now,
    });
    expect(result.active.map((entry) => entry.id)).toEqual(["woke"]);
    expect(result.nextWakeAtMs).toBe(Date.parse("2026-09-01T13:00:00.000Z"));
  });

  it("reports the earliest wake among scoped threads and leaves out settled and archived ones", () => {
    const result = partitionRailThreads({
      threads: [
        thread("later", {
          snoozedAt: "2026-09-01T11:00:00.000Z",
          snoozedUntil: "2026-09-01T18:00:00.000Z",
        }),
        thread("sooner", {
          snoozedAt: "2026-09-01T11:00:00.000Z",
          snoozedUntil: "2026-09-01T12:30:00.000Z",
        }),
        thread("other-profile", {
          projectId: ProjectId.make("project-2"),
          snoozedAt: "2026-09-01T11:00:00.000Z",
          snoozedUntil: "2026-09-01T12:05:00.000Z",
        }),
        thread("settled", { settledOverride: "settled" }),
        thread("archived", { archivedAt: "2026-09-01T09:00:00.000Z" }),
        thread("pinned", { pinnedAt: "2026-09-01T09:00:00.000Z" }),
      ],
      scopedProjectKeys: new Set([`${environmentId}:${projectId}`]),
      now,
    });
    expect(result.pinned.map((entry) => entry.id)).toEqual(["pinned"]);
    expect(result.active).toEqual([]);
    expect(result.nextWakeAtMs).toBe(Date.parse("2026-09-01T12:30:00.000Z"));
  });
});
