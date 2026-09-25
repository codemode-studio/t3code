import * as Schema from "effect/Schema";
import { MessageId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const NoteId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("NoteId"),
);
export type NoteId = typeof NoteId.Type;

const NoteTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const NoteBody = Schema.String.check(Schema.isMaxLength(128_000));
const NoteTags = Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(40))).check(
  Schema.isMaxLength(20),
);

export const NoteSummary = Schema.Struct({
  id: NoteId,
  title: NoteTitle,
  tags: NoteTags,
  projectId: Schema.NullOr(ProjectId),
  sourceThreadId: Schema.NullOr(ThreadId),
  sourceMessageId: Schema.NullOr(MessageId),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type NoteSummary = typeof NoteSummary.Type;

export const Note = Schema.Struct({ ...NoteSummary.fields, body: NoteBody });
export type Note = typeof Note.Type;

export const NoteListInput = Schema.Struct({
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
});
export type NoteListInput = typeof NoteListInput.Type;

export const NoteListResult = Schema.Struct({ notes: Schema.Array(NoteSummary) });
export type NoteListResult = typeof NoteListResult.Type;

export const NoteIdInput = Schema.Struct({ id: NoteId });
export type NoteIdInput = typeof NoteIdInput.Type;

export const NoteCreateInput = Schema.Struct({
  title: NoteTitle,
  body: NoteBody,
  tags: NoteTags,
  projectId: Schema.NullOr(ProjectId),
  sourceThreadId: Schema.NullOr(ThreadId),
  sourceMessageId: Schema.NullOr(MessageId),
});
export type NoteCreateInput = typeof NoteCreateInput.Type;

export const NoteUpdateInput = Schema.Struct({
  id: NoteId,
  title: NoteTitle,
  body: NoteBody,
  tags: NoteTags,
  projectId: Schema.NullOr(ProjectId),
});
export type NoteUpdateInput = typeof NoteUpdateInput.Type;

export class NoteError extends Schema.TaggedError<NoteError>()("NoteError", {
  message: Schema.String,
}) {}
