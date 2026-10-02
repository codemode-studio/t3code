import type { ProviderProfileId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { profileScopeProjectKey } from "@t3tools/client-runtime/state/profile-scope";

import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
} from "../components/Sidebar.logic";

/** The thread fields that decide whether it waits on the user and which profile it counts for. */
export type AttentionThread = Pick<
  EnvironmentThreadShell,
  | "id"
  | "environmentId"
  | "projectId"
  | "archivedAt"
  | "settledOverride"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "hasActionableProposedPlan"
  | "interactionMode"
  | "runtime"
  | "latestRun"
  | "lastVisitedAt"
>;

/**
 * Whether a thread is waiting on the user: an approval, a question, a failure, or a completion
 * they have not seen. Working threads do not count; they need no action yet.
 */
export function threadNeedsAttention(
  thread: AttentionThread,
  localLastVisitedAt: string | undefined,
): boolean {
  if (thread.archivedAt !== null || thread.settledOverride === "settled") return false;
  const status = resolveSidebarThreadStatus(thread);
  if (status === "approval" || status === "input" || status === "failed") return true;
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  return status === "ready" && hasUnseenCompletion({ ...thread, lastVisitedAt });
}

/** Threads waiting on the user, per profile id (null for projects without a profile). */
export function countAttentionByProfile(input: {
  readonly threads: ReadonlyArray<AttentionThread>;
  readonly projectProfiles: ReadonlyMap<string, ProviderProfileId | null>;
  readonly lastVisitedAtByThreadKey: Readonly<Record<string, string>>;
  readonly threadKey: (thread: AttentionThread) => string;
}): ReadonlyMap<ProviderProfileId | null, number> {
  const counts = new Map<ProviderProfileId | null, number>();
  for (const thread of input.threads) {
    if (!threadNeedsAttention(thread, input.lastVisitedAtByThreadKey[input.threadKey(thread)])) {
      continue;
    }
    const profileId =
      input.projectProfiles.get(profileScopeProjectKey(thread.environmentId, thread.projectId)) ??
      null;
    counts.set(profileId, (counts.get(profileId) ?? 0) + 1);
  }
  return counts;
}
