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

/**
 * Attaches the note an Add to chat request queued to the draft that request opened. It waits
 * while the draft still shows another project (the flow's previous or first-project default),
 * and leaves the note queued when the draft refuses it, so a later attempt can still succeed.
 */
export function attachPendingNoteToDraft(input: {
  readonly draftKey: string;
  readonly selectedProject: { readonly environmentId: EnvironmentId; readonly id: string } | null;
  readonly routeProject:
    | { readonly environmentId?: string | undefined; readonly projectId?: string | undefined }
    | undefined;
  readonly requestId: string | undefined;
  readonly insert: (draftKey: string, note: NoteSummary) => boolean;
}): "attached" | "waiting" | "rejected" {
  const project = input.selectedProject;
  if (!project) return "waiting";
  const route = input.routeProject;
  if (
    route?.projectId &&
    (project.environmentId !== route.environmentId || project.id !== route.projectId)
  ) {
    return "waiting";
  }
  const note = pendingNoteForChat(project.environmentId, input.requestId);
  if (!note) return "waiting";
  if (!input.insert(input.draftKey, note)) return "rejected";
  clearPendingNoteForChat(project.environmentId, note.id);
  return "attached";
}
