import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  NoteError,
  type EnvironmentId,
  type MessageId,
  type NoteCreateInput,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** The server's note body limit. */
export const NOTE_BODY_MAX_LENGTH = 128_000;

/**
 * A transcript message the user chose to save, captured when they tapped Save so a
 * later route change or text selection cannot credit it to another thread.
 */
export interface TranscriptNoteTarget {
  readonly environmentId: EnvironmentId;
  readonly displayedThreadId: ThreadId;
  /** The displayed thread's project when Save was tapped, or null if that thread was unknown. */
  readonly displayedProjectId: ProjectId | null;
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
 * Resolves a saved message's provenance. A forked thread shows its parent's messages, which the
 * server stores under the parent, so the source is the owning thread, not the one on screen.
 * Null for a message the server has not persisted yet.
 *
 * `threadProjectId` answers with a live thread's project in the target's environment, or
 * `undefined` when the thread is unknown or deleted. Then the note keeps the text and the
 * project captured at tap, without claiming a source thread or message.
 */
export function resolveNoteSource(
  target: TranscriptNoteTarget,
  threadProjectId: (threadId: ThreadId) => ProjectId | undefined,
): NoteSource | null {
  const sourceThreadId = target.messageThreadId;
  if (sourceThreadId === undefined) return null;
  const projectId = threadProjectId(sourceThreadId);
  if (projectId !== undefined) {
    return { projectId, sourceThreadId, sourceMessageId: target.messageId };
  }
  return { projectId: target.displayedProjectId, sourceThreadId: null, sourceMessageId: null };
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

const isNoteError = Schema.is(NoteError);
// The server checks these before writing, so nothing was saved and one retry cannot duplicate.
const ASSOCIATION_REJECTIONS = new Set([
  "Project was not found on this environment.",
  "Source thread does not belong to this project and environment.",
  "Source message is not complete on this environment.",
]);

export type TranscriptNoteSave =
  | { readonly _tag: "saved"; readonly title: string }
  | { readonly _tag: "not-persisted" }
  | { readonly _tag: "too-long" }
  | { readonly _tag: "interrupted" }
  | { readonly _tag: "failed"; readonly detail: string };

/**
 * Saves transcript text as a note. When the server refuses the note's project or source before
 * writing it, it retries once with no association so the text is kept. Every other failure is
 * reported as is: a lost reply may have saved the note already.
 */
export async function saveTranscriptNote(input: {
  readonly target: TranscriptNoteTarget;
  readonly text: string;
  readonly threadProjectId: (threadId: ThreadId) => ProjectId | undefined;
  readonly create: (note: NoteCreateInput) => Promise<AtomCommandResult<unknown, unknown>>;
}): Promise<TranscriptNoteSave> {
  const body = input.text.trim();
  if (body.length > NOTE_BODY_MAX_LENGTH) return { _tag: "too-long" };
  const source = resolveNoteSource(input.target, input.threadProjectId);
  if (!source) return { _tag: "not-persisted" };
  const title = transcriptNoteTitle(body);
  const note = { title, body, tags: [], ...source };
  let result = await input.create(note);
  const associated =
    source.projectId !== null || source.sourceThreadId !== null || source.sourceMessageId !== null;
  if (associated && isAssociationRejection(result)) {
    result = await input.create({
      ...note,
      projectId: null,
      sourceThreadId: null,
      sourceMessageId: null,
    });
  }
  if (result._tag === "Success") return { _tag: "saved", title };
  if (isAtomCommandInterrupted(result)) return { _tag: "interrupted" };
  const error = squashAtomCommandFailure(result);
  return {
    _tag: "failed",
    detail:
      error instanceof Error && error.message ? error.message : "The note could not be saved.",
  };
}

function isAssociationRejection(result: AtomCommandResult<unknown, unknown>): boolean {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return false;
  const error = squashAtomCommandFailure(result);
  return isNoteError(error) && ASSOCIATION_REJECTIONS.has(error.message);
}
