import * as NodeCrypto from "node:crypto";
import type {
  ComposerContextRecord,
  Note,
  NoteCreateInput,
  NoteId,
  NoteListInput,
  NoteSummary,
  NoteUpdateInput,
  OrchestrationCommand,
} from "@t3tools/contracts";
import { NoteContextRecord, NoteError, NoteId as NoteIdSchema } from "@t3tools/contracts";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { planAttachmentClaim } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";

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
const isNoteError = Schema.is(NoteError);

const imageReference = /t3-note-image:\/\/(pending-[a-f0-9-]{36}(?:-[a-z0-9]{1,10})?)/gi;

function claimImages(body: string, noteId: NoteId) {
  return Effect.gen(function* () {
    const pendingIds = [...new Set([...body.matchAll(imageReference)].map((match) => match[1]!))];
    if (pendingIds.length === 0) return body;
    const config = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    let resolved = body;
    for (const pendingId of pendingIds) {
      const claim = planAttachmentClaim({
        attachmentsDir: config.attachmentsDir,
        threadId: `note-${noteId}`,
        attachmentId: pendingId,
      });
      if (!claim.ok)
        return yield* new NoteError({ message: `Note image ${pendingId}: ${claim.reason}.` });
      yield* fileSystem.rename(claim.currentPath, claim.finalPath);
      resolved = resolved.replaceAll(
        `t3-note-image://${pendingId}`,
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
    tags: Schema.decodeSync(TagsJson)(row.tags_json),
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
    if (input.sourceThreadId !== null) {
      const threads = yield* sql<{ project_id: string }>`
        SELECT project_id FROM projection_threads WHERE thread_id = ${input.sourceThreadId} AND deleted_at IS NULL
      `;
      if (
        threads.length === 0 ||
        (input.projectId !== null && threads[0]?.project_id !== input.projectId)
      ) {
        return yield* new NoteError({
          message: "Source thread does not belong to this project and environment.",
        });
      }
    }
    if (input.sourceMessageId !== null) {
      const messages = yield* sql<{ message_id: string }>`
        SELECT message_id FROM projection_thread_messages
        WHERE message_id = ${input.sourceMessageId} AND thread_id = ${input.sourceThreadId}
          AND is_streaming = 0
      `;
      if (messages.length === 0)
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
    const tagsJson = yield* Schema.encodeEffect(TagsJson)(input.tags);
    const body = yield* claimImages(input.body, id);
    yield* sql`
      INSERT INTO notes (id, title, body, tags_json, project_id, source_thread_id, source_message_id, created_at, updated_at)
      VALUES (${id}, ${input.title}, ${body}, ${tagsJson}, ${input.projectId}, ${input.sourceThreadId}, ${input.sourceMessageId}, ${now}, ${now})
    `;
    return yield* getNote(id);
  }).pipe(Effect.mapError((cause) => (isNoteError(cause) ? cause : failed("create")(cause))));

export const updateNote = (input: NoteUpdateInput) =>
  Effect.gen(function* () {
    yield* getNote(input.id);
    yield* validateAssociation({
      projectId: input.projectId,
      sourceThreadId: null,
      sourceMessageId: null,
    });
    const sql = yield* SqlClient.SqlClient;
    const tagsJson = yield* Schema.encodeEffect(TagsJson)(input.tags);
    const now = DateTime.formatIso(yield* DateTime.now);
    const body = yield* claimImages(input.body, input.id);
    yield* sql`
      UPDATE notes SET title = ${input.title}, body = ${body}, tags_json = ${tagsJson},
        project_id = ${input.projectId}, updated_at = ${now}
      WHERE id = ${input.id}
    `;
    return yield* getNote(input.id);
  }).pipe(Effect.mapError((cause) => (isNoteError(cause) ? cause : failed("update")(cause))));

export const deleteNote = (id: NoteId) =>
  Effect.gen(function* () {
    yield* getNote(id);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM notes WHERE id = ${id}`;
  }).pipe(Effect.mapError((cause) => (isNoteError(cause) ? cause : failed("delete")(cause))));

/** Resolve on the owning server, before the message is appended to the event log. */
export const snapshotNotesInCommand = (command: OrchestrationCommand) =>
  Effect.gen(function* () {
    if (command.type !== "thread.turn.start") return command;
    const references = collectComposerContextReferences(command.message.text).filter(
      (reference) => reference.kind === "note",
    );
    if (references.length === 0) return command;
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
      ...(command.message.context?.records.filter((record) => record.kind !== "note") ?? []),
      ...notes,
    ];
    return {
      ...command,
      message: {
        ...command.message,
        context: { version: 1, records },
      },
    } satisfies OrchestrationCommand;
  });
