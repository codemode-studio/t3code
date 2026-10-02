import * as NodeCrypto from "node:crypto";
import type {
  ComposerContextRecord,
  Note,
  NoteCreateInput,
  NoteId,
  NoteListInput,
  NoteSummary,
  NoteUpdateInput,
  OrchestrationMessageContext,
  OrchestrationV2Command,
} from "@t3tools/contracts";
import { NoteContextRecord, NoteError, NoteId as NoteIdSchema } from "@t3tools/contracts";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { planAttachmentClaim } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

interface NoteRow {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly tags_json: string;
  readonly project_id: string | null;
  readonly source_thread_id: string | null;
  readonly source_message_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const TagsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeTagsJson = Schema.decodeSync(TagsJson);
const encodeTagsJson = Schema.encodeEffect(TagsJson);
const isNoteError = Schema.is(NoteError);

const imageReference = /t3-note-image:\/\/(pending-[a-f0-9-]{36}(?:-[a-z0-9]{1,10})?)/gi;

function claimImages(body: string, noteId: NoteId) {
  return Effect.gen(function* () {
    const pendingIds = [...new Set([...body.matchAll(imageReference)].map((match) => match[1]!))];
    if (pendingIds.length === 0) return body;
    const config = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const claims = yield* Effect.forEach(pendingIds, (pendingId) =>
      Effect.gen(function* () {
        const claim = planAttachmentClaim({
          attachmentsDir: config.attachmentsDir,
          threadId: `note-${noteId}`,
          attachmentId: pendingId,
        });
        if (!claim.ok)
          return yield* new NoteError({ message: `Note image ${pendingId}: ${claim.reason}.` });
        return { ...claim, pendingId };
      }),
    );
    let resolved = body;
    for (const claim of claims) {
      // Keep the upload reusable when a later move or the database write fails.
      yield* Effect.acquireRelease(
        fileSystem.rename(claim.currentPath, claim.finalPath),
        (_, exit) =>
          Exit.isFailure(exit)
            ? fileSystem
                .rename(claim.finalPath, claim.currentPath)
                .pipe(Effect.ignoreCause({ log: true }))
            : Effect.void,
      );
      resolved = resolved.replaceAll(
        `t3-note-image://${claim.pendingId}`,
        `t3-note-image://${claim.finalId}`,
      );
    }
    return resolved;
  });
}

function fromRow(row: NoteRow): Note {
  return {
    id: NoteIdSchema.make(row.id),
    title: row.title,
    body: row.body,
    tags: decodeTagsJson(row.tags_json),
    projectId: row.project_id as Note["projectId"],
    sourceThreadId: row.source_thread_id as Note["sourceThreadId"],
    sourceMessageId: row.source_message_id as Note["sourceMessageId"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function fromSummaryRow(row: Omit<NoteRow, "body">): NoteSummary {
  const { body: _body, ...summary } = fromRow({ ...row, body: "" });
  return summary;
}

const failed = (operation: string) => (cause: unknown) =>
  new NoteError({
    message: `Could not ${operation} notes: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

export const listNotes = (input: NoteListInput) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const query = input.query?.trim() ?? "";
    const pattern = `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const rows = yield* sql<Omit<NoteRow, "body">>`
      SELECT id, title, tags_json, project_id, source_thread_id, source_message_id, created_at, updated_at FROM notes
      WHERE (${query} = '' OR title LIKE ${pattern} ESCAPE char(92) OR body LIKE ${pattern} ESCAPE char(92) OR tags_json LIKE ${pattern} ESCAPE char(92))
        AND (${input.projectId === undefined ? 1 : 0} = 1 OR project_id IS ${input.projectId ?? null})
      ORDER BY updated_at DESC, id DESC
      LIMIT 1000
    `;
    return { notes: rows.map(fromSummaryRow) };
  }).pipe(Effect.mapError(failed("list")));

export const getNote = (id: NoteId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<NoteRow>`SELECT * FROM notes WHERE id = ${id}`;
    if (!rows[0]) return yield* new NoteError({ message: "Note was not found." });
    return fromRow(rows[0]);
  }).pipe(Effect.mapError((cause) => (isNoteError(cause) ? cause : failed("read")(cause))));

const validateAssociation = (
  input: Pick<NoteCreateInput, "projectId" | "sourceThreadId" | "sourceMessageId">,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (input.projectId !== null) {
      const projects = yield* sql<{ project_id: string }>`
        SELECT project_id FROM projection_projects WHERE project_id = ${input.projectId} AND deleted_at IS NULL
      `;
      if (projects.length === 0)
        return yield* new NoteError({ message: "Project was not found on this environment." });
    }
    if (input.sourceThreadId === null) {
      if (input.sourceMessageId === null) return;
      return yield* new NoteError({
        message: "Source message is not complete on this environment.",
      });
    }
    const threads = yield* ThreadManagementService.ThreadManagementService;
    // Null for unknown and deleted threads alike.
    const shell = yield* threads.getThreadShell(input.sourceThreadId);
    if (shell === null || (input.projectId !== null && shell.projectId !== input.projectId)) {
      return yield* new NoteError({
        message: "Source thread does not belong to this project and environment.",
      });
    }
    if (input.sourceMessageId === null) return;
    // Reading records first copies a thread imported from before V2 into V2, so a note can
    // come from a transcript nobody has opened since the upgrade.
    const { messages } = yield* threads.getThreadRecords(input.sourceThreadId, ["messages"], {
      messageIds: [input.sourceMessageId],
    });
    if (!messages.some((message) => message.id === input.sourceMessageId && !message.streaming)) {
      return yield* new NoteError({
        message: "Source message is not complete on this environment.",
      });
    }
  });

export const createNote = (input: NoteCreateInput) =>
  Effect.gen(function* () {
    yield* validateAssociation(input);
    const sql = yield* SqlClient.SqlClient;
    const id = NoteIdSchema.make(NodeCrypto.randomUUID());
    const now = DateTime.formatIso(yield* DateTime.now);
    const tagsJson = yield* encodeTagsJson(input.tags);
    const body = yield* claimImages(input.body, id);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
      INSERT INTO notes (id, title, body, tags_json, project_id, source_thread_id, source_message_id, created_at, updated_at)
      VALUES (${id}, ${input.title}, ${body}, ${tagsJson}, ${input.projectId}, ${input.sourceThreadId}, ${input.sourceMessageId}, ${now}, ${now})
    `;
        return yield* getNote(id);
      }),
    );
  }).pipe(
    Effect.scoped,
    Effect.uninterruptible,
    Effect.mapError((cause) => (isNoteError(cause) ? cause : failed("create")(cause))),
  );

export const updateNote = (input: NoteUpdateInput) =>
  Effect.gen(function* () {
    yield* getNote(input.id);
    // Project assignment can change independently of the note's original transcript source.
    yield* validateAssociation({
      projectId: input.projectId,
      sourceThreadId: null,
      sourceMessageId: null,
    });
    const sql = yield* SqlClient.SqlClient;
    const tagsJson = yield* encodeTagsJson(input.tags);
    const now = DateTime.formatIso(yield* DateTime.now);
    const body = yield* claimImages(input.body, input.id);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
      UPDATE notes SET title = ${input.title}, body = ${body}, tags_json = ${tagsJson},
        project_id = ${input.projectId}, updated_at = ${now}
      WHERE id = ${input.id}
    `;
        return yield* getNote(input.id);
      }),
    );
  }).pipe(
    Effect.scoped,
    Effect.uninterruptible,
    Effect.mapError((cause) => (isNoteError(cause) ? cause : failed("update")(cause))),
  );

export const deleteNote = (id: NoteId) =>
  Effect.gen(function* () {
    yield* getNote(id);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM notes WHERE id = ${id}`;
  }).pipe(Effect.mapError((cause) => (isNoteError(cause) ? cause : failed("delete")(cause))));

/** Share one feed across the server's WebSocket sessions; reconnects receive the current revision. */
export const makeNotes = Effect.gen(function* () {
  const revision = yield* SubscriptionRef.make(0);
  const changed = SubscriptionRef.update(revision, (value) => value + 1);
  return {
    changes: SubscriptionRef.changes(revision),
    create: (input: NoteCreateInput) =>
      createNote(input).pipe(
        Effect.tap(() => changed),
        Effect.uninterruptible,
      ),
    update: (input: NoteUpdateInput) =>
      updateNote(input).pipe(
        Effect.tap(() => changed),
        Effect.uninterruptible,
      ),
    remove: (id: NoteId) =>
      deleteNote(id).pipe(
        Effect.tap(() => changed),
        Effect.uninterruptible,
      ),
  };
});

/**
 * Copies every note the message references into its context, so the message keeps the note as
 * it was when sent. Resolved on the owning server before the message reaches the event log.
 */
export const snapshotNotesInMessage = (message: {
  readonly text: string;
  readonly context?: OrchestrationMessageContext | undefined;
}) =>
  Effect.gen(function* () {
    const references = collectComposerContextReferences(message.text).filter(
      (reference) => reference.kind === "note",
    );
    if (references.length === 0) return message.context;
    const unique = [
      ...new Map(references.map((reference) => [reference.contextId, reference])).values(),
    ];
    const notes = yield* Effect.forEach(unique, (reference) =>
      Effect.gen(function* () {
        if (!/^note_[a-f0-9-]{36}$/i.test(reference.contextId)) {
          return yield* new NoteError({ message: "Invalid note reference." });
        }
        const noteId = NoteIdSchema.make(reference.contextId.slice(5));
        const note = yield* getNote(noteId);
        return {
          version: 1 as const,
          kind: "note" as const,
          contextId: reference.contextId,
          noteId,
          label: note.title,
          title: note.title,
          content: note.body,
        } satisfies NoteContextRecord;
      }),
    );
    const records: ComposerContextRecord[] = [
      ...(message.context?.records.filter((record) => record.kind !== "note") ?? []),
      ...notes,
    ];
    return { version: 1, records } satisfies OrchestrationMessageContext;
  });

/**
 * Applies `snapshotNotesInMessage` to the client commands that carry message text. A queued-run
 * edit without context keeps the queued message's own records, which the edit would otherwise
 * replace with only the notes; context the client does send is authoritative.
 */
export const snapshotNotesInCommand = (command: OrchestrationV2Command) =>
  Effect.gen(function* () {
    if (command.type !== "message.dispatch" && command.type !== "queued-run.edit") {
      return command;
    }
    let base = command.context;
    if (command.type === "queued-run.edit" && base === undefined) {
      if (!hasNoteReference(command.text)) return command;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const queued = yield* threads.getThreadRecords(command.threadId, ["runs", "messages"], {
        runIds: [command.runId],
        messageRunIds: [command.runId],
      });
      const run = queued.runs.find((candidate) => candidate.id === command.runId);
      base = queued.messages.find((message) => message.id === run?.userMessageId)?.context;
    }
    const context = yield* snapshotNotesInMessage({ text: command.text, context: base });
    return context === undefined ? command : ({ ...command, context } as OrchestrationV2Command);
  });

function hasNoteReference(text: string): boolean {
  return collectComposerContextReferences(text).some((reference) => reference.kind === "note");
}
