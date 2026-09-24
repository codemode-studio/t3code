import type { EnvironmentId, NoteSummary } from "@t3tools/contracts";

let pending: { environmentId: EnvironmentId; note: NoteSummary } | null = null;

export function queueNoteForChat(environmentId: EnvironmentId, note: NoteSummary): void {
  pending = { environmentId, note };
}

export function pendingNoteForChat(environmentId: EnvironmentId): NoteSummary | null {
  return pending?.environmentId === environmentId ? pending.note : null;
}

export function clearPendingNoteForChat(environmentId: EnvironmentId, id: NoteSummary["id"]): void {
  if (pending?.environmentId === environmentId && pending.note.id === id) pending = null;
}
