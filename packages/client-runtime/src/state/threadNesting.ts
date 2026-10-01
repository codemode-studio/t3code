import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";

interface NestableThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly parentThreadId?: ThreadId | null | undefined;
  readonly createdAt: string;
}

export interface NestedThreads<T> {
  /** Children by their parent's scoped key, oldest first. */
  readonly childrenByParentKey: ReadonlyMap<string, readonly T[]>;
  /** Scoped keys of threads that render under a parent instead of on their own. */
  readonly nestedKeys: ReadonlySet<string>;
}

const keyOf = (thread: NestableThread) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

/**
 * Groups delegated threads under the thread that started them, one level
 * deep. Only `hosts` take children: pass the rows that always render (pinned
 * and active), so a child that needs attention is never folded into a
 * collapsed shelf. A child whose parent is not a host keeps its own row.
 */
export function nestThreadsUnderParents<T extends NestableThread>(
  hosts: readonly T[],
  threads: readonly T[],
): NestedThreads<T> {
  const hostByKey = new Map(
    hosts
      .filter((thread) => thread.parentThreadId == null)
      .map((thread) => [keyOf(thread), thread] as const),
  );
  const childrenByParentKey = new Map<string, T[]>();
  const nestedKeys = new Set<string>();
  for (const thread of threads) {
    const parentId = thread.parentThreadId;
    if (parentId == null) continue;
    const parentKey = scopedThreadKey(scopeThreadRef(thread.environmentId, parentId));
    if (!hostByKey.has(parentKey)) continue;
    const children = childrenByParentKey.get(parentKey) ?? [];
    children.push(thread);
    childrenByParentKey.set(parentKey, children);
    nestedKeys.add(keyOf(thread));
  }
  for (const children of childrenByParentKey.values()) {
    children.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
  return { childrenByParentKey, nestedKeys };
}

/**
 * `threads` in display order with each one's nested children right after it.
 * Lookups, search, selection, and keyboard order use this so a nested child
 * stays reachable even though it renders inside its parent's row.
 */
export function withNestedChildren<T extends NestableThread>(
  threads: readonly T[],
  childrenByParentKey: ReadonlyMap<string, readonly T[]>,
): T[] {
  if (childrenByParentKey.size === 0) return [...threads];
  return threads.flatMap((thread) => [thread, ...(childrenByParentKey.get(keyOf(thread)) ?? [])]);
}
