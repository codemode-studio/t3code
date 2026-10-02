import type { MessageId, ProjectId, ThreadId } from "@t3tools/contracts";

/** Where a note saved from a transcript message comes from, as the server validates it. */
export interface NoteSource {
  readonly projectId: ProjectId | null;
  readonly sourceThreadId: ThreadId | null;
  readonly sourceMessageId: MessageId | null;
}

/**
 * Resolves a saved message's provenance. A forked thread shows its parent's messages, which the
 * server stores under the parent, so the source is the thread that owns the message, not the one
 * on screen. Returns null for a message the server has not persisted yet.
 *
 * `threadProjectId` answers with the owning thread's project, or `undefined` when this client
 * no longer knows the thread (deleted parent): the note then keeps the text without a source.
 */
export function resolveNoteSource(input: {
  readonly messageId: MessageId;
  /** The owning thread of each persisted message in the displayed timeline. */
  readonly messageThreadId: ThreadId | undefined;
  readonly displayedThreadId: ThreadId;
  readonly displayedProjectId: ProjectId | null;
  readonly threadProjectId: (threadId: ThreadId) => ProjectId | undefined;
}): NoteSource | null {
  const sourceThreadId = input.messageThreadId;
  if (sourceThreadId === undefined) return null;
  const projectId = input.threadProjectId(sourceThreadId);
  if (projectId !== undefined) {
    return { projectId, sourceThreadId, sourceMessageId: input.messageId };
  }
  if (sourceThreadId === input.displayedThreadId) {
    return {
      projectId: input.displayedProjectId,
      sourceThreadId,
      sourceMessageId: input.messageId,
    };
  }
  return { projectId: input.displayedProjectId, sourceThreadId: null, sourceMessageId: null };
}
