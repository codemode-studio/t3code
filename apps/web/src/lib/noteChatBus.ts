import type { EnvironmentId, NoteSummary } from "@t3tools/contracts";

let pending: { readonly environmentId: EnvironmentId; readonly note: NoteSummary } | null = null;

export function queueNoteForChat(environmentId: EnvironmentId, note: NoteSummary): void {
  pending = { environmentId, note };
}

export function pendingNoteForChat(environmentId: EnvironmentId): NoteSummary | null {
  if (pending?.environmentId !== environmentId) return null;
  return pending.note;
}

export function clearPendingNoteForChat(
  environmentId: EnvironmentId,
  noteId: NoteSummary["id"],
): void {
  if (pending?.environmentId === environmentId && pending.note.id === noteId) pending = null;
}
