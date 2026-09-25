import type { EnvironmentId, NoteSummary } from "@t3tools/contracts";

import { uuidv4 } from "../../lib/uuid";

let pending: { requestId: string; environmentId: EnvironmentId; note: NoteSummary } | null = null;

export function queueNoteForChat(environmentId: EnvironmentId, note: NoteSummary): string {
  const requestId = uuidv4();
  pending = { requestId, environmentId, note };
  return requestId;
}

export function pendingNoteForChat(
  environmentId: EnvironmentId,
  requestId: string | undefined,
): NoteSummary | null {
  return pending?.environmentId === environmentId && pending.requestId === requestId
    ? pending.note
    : null;
}

export function clearPendingNoteForChat(environmentId: EnvironmentId, id: NoteSummary["id"]): void {
  if (pending?.environmentId === environmentId && pending.note.id === id) pending = null;
}
