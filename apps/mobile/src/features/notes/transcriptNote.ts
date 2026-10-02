import type { EnvironmentId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";

/**
 * A transcript message the user chose to save, captured when they tapped Save so a
 * later route change or text selection cannot credit it to another thread.
 */
export interface TranscriptNoteTarget {
  readonly environmentId: EnvironmentId;
  readonly displayedThreadId: ThreadId;
  readonly messageId: MessageId;
  /** The thread that stores the message (`projectedItem.sourceThreadId`); unset until persisted. */
  readonly messageThreadId: ThreadId | undefined;
}

/** Where a note saved from a transcript message comes from, as the server validates it. */
export interface NoteSource {
  readonly projectId: ProjectId | null;
  readonly sourceThreadId: ThreadId | null;
  readonly sourceMessageId: MessageId | null;
}

/**
 * Resolves a saved message's provenance, matching web's `resolveNoteSource`. A forked thread
 * shows its parent's messages, which the server stores under the parent, so the source is the
 * owning thread, not the one on screen. Null for a message the server has not persisted yet.
 *
 * `threadProjectId` answers with a thread's project in the target's environment, or `undefined`
 * when the thread is unknown or deleted: the note then keeps the text without a source.
 */
export function resolveNoteSource(
  target: TranscriptNoteTarget,
  threadProjectId: (threadId: ThreadId) => ProjectId | null | undefined,
): NoteSource | null {
  const sourceThreadId = target.messageThreadId;
  if (sourceThreadId === undefined) return null;
  const projectId = threadProjectId(sourceThreadId);
  if (projectId !== undefined) {
    return { projectId, sourceThreadId, sourceMessageId: target.messageId };
  }
  const displayedProjectId = threadProjectId(target.displayedThreadId) ?? null;
  if (sourceThreadId === target.displayedThreadId) {
    return { projectId: displayedProjectId, sourceThreadId, sourceMessageId: target.messageId };
  }
  return { projectId: displayedProjectId, sourceThreadId: null, sourceMessageId: null };
}

/** The first line of the saved text, without markdown heading marks. */
export function transcriptNoteTitle(body: string): string {
  return (
    body
      .trim()
      .split("\n", 1)[0]
      ?.replace(/^#+\s*/, "")
      .slice(0, 120)
      .trim() || "Transcript note"
  );
}
