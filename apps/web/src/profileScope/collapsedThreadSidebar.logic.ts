import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { profileScopeProjectKey } from "@t3tools/client-runtime/state/profile-scope";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";

import { sortPinnedThreadsForSidebar, sortThreadsForSidebar } from "../components/Sidebar.logic";

/** The thread fields the rail sorts, filters and snoozes by. */
export type RailThread = Pick<
  EnvironmentThreadShell,
  | "id"
  | "environmentId"
  | "projectId"
  | "createdAt"
  | "archivedAt"
  | "settledOverride"
  | "pinnedAt"
  | "pinOrderKey"
  | "activeOrderKey"
  | "unsettledAt"
  | "snoozedUntil"
  | "snoozedAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "session"
  | "latestTurn"
>;

/**
 * The rail's pinned and active threads in sidebar order, leaving out archived, settled, snoozed
 * and out-of-scope ones, plus when the next snooze ends so the rail can wake it on time.
 * `now` is compared as a full UTC timestamp: snooze times are UTC, and a zone-less string
 * would be read as local time.
 */
export function partitionRailThreads<T extends RailThread>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly now: Date;
}): { readonly pinned: T[]; readonly active: T[]; readonly nextWakeAtMs: number | null } {
  const now = input.now.toISOString();
  const pinned: T[] = [];
  const active: T[] = [];
  let nextWakeAtMs: number | null = null;
  for (const thread of input.threads) {
    if (thread.archivedAt !== null || thread.settledOverride === "settled") continue;
    if (
      input.scopedProjectKeys !== null &&
      !input.scopedProjectKeys.has(profileScopeProjectKey(thread.environmentId, thread.projectId))
    ) {
      continue;
    }
    if (effectiveSnoozed(thread, { now })) {
      const wakeAtMs = Date.parse(thread.snoozedUntil ?? "");
      if (nextWakeAtMs === null || wakeAtMs < nextWakeAtMs) nextWakeAtMs = wakeAtMs;
      continue;
    }
    (thread.pinnedAt != null ? pinned : active).push(thread);
  }
  return {
    pinned: sortPinnedThreadsForSidebar(pinned),
    active: sortThreadsForSidebar(active),
    nextWakeAtMs,
  };
}
