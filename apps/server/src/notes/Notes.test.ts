// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ComposerContextId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import {
  formatComposerContextReference,
  projectComposerContextForProvider,
} from "@t3tools/shared/composerContextReferences";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import {
  makeOrchestrationV2TestLayer,
  seedProject,
  testModelSelection,
} from "../testUtils/orchestrationV2.ts";
import {
  createNote,
  deleteNote,
  getNote,
  listNotes,
  makeNotes,
  snapshotNotesInCommand,
  snapshotNotesInMessage,
  updateNote,
} from "./Notes.ts";

const projectId = ProjectId.make("notes-project");
const threadId = ThreadId.make("notes-thread");
const messageId = MessageId.make("notes-message");
const testLayer = makeOrchestrationV2TestLayer("t3-notes-test-");

const createThread = (id: ThreadId) =>
  Effect.flatMap(ThreadManagementService.ThreadManagementService, (threads) =>
    threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${id}`),
      createdBy: "user",
      creationSource: "web",
      threadId: id,
      projectId,
      title: "Thread",
      modelSelection: testModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    }),
  );

/** An agent reply the way provider ingestion records it. */
const writeReply = (thread: ThreadId, id: MessageId, streaming: boolean) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`reply:${id}`),
          type: "message.updated",
          threadId: thread,
          occurredAt: now,
          payload: {
            createdBy: "agent",
            creationSource: "provider",
            id,
            threadId: thread,
            runId: null,
            nodeId: null,
            role: "assistant",
            text: "Source",
            attachments: [],
            streaming,
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
    });
  });

const sourced = (sourceThreadId: ThreadId | null, sourceMessageId: MessageId | null) => ({
  title: "Sourced",
  body: "",
  tags: [],
  projectId,
  sourceThreadId,
  sourceMessageId,
});

it.layer(testLayer)("notes", (it) => {
  it.effect(
    "notifies every connected client after mutations and supplies the revision on reconnect",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const notes = yield* makeNotes;
          const first = yield* Stream.toPull(notes.changes);
          const second = yield* Stream.toPull(notes.changes);
          expect(yield* first).toEqual([0]);
          expect(yield* second).toEqual([0]);
          const note = yield* notes.create({
            title: "Shared",
            body: "One",
            tags: [],
            projectId: null,
            sourceThreadId: null,
            sourceMessageId: null,
          });
          expect(yield* first).toEqual([1]);
          expect(yield* second).toEqual([1]);
          yield* notes.update({ ...note, body: "Two" });
          expect(yield* first).toEqual([2]);
          expect(yield* second).toEqual([2]);
          yield* notes.remove(note.id);
          expect(yield* first).toEqual([3]);
          expect(yield* second).toEqual([3]);
          const failed = yield* notes.remove(note.id).pipe(Effect.result);
          expect(failed._tag).toBe("Failure");
          const reconnected = yield* Stream.toPull(notes.changes);
          expect(yield* reconnected).toEqual([3]);
        }),
      ),
  );

  it.effect("keeps uploads usable when a later image is missing", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const pendingId = "pending-00000000-0000-4000-8000-000000000002";
      NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
      const pendingPath = NodePath.join(config.attachmentsDir, `${pendingId}.png`);
      NodeFS.writeFileSync(pendingPath, "image bytes");
      const input = {
        title: "Retry missing image",
        body: `![Good](t3-note-image://${pendingId})`,
        tags: [],
        projectId: null,
        sourceThreadId: null,
        sourceMessageId: null,
      };
      const result = yield* createNote({
        ...input,
        body: `${input.body}\n![Missing](t3-note-image://pending-00000000-0000-4000-8000-000000000003)`,
      }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(NodeFS.readFileSync(pendingPath, "utf8")).toBe("image bytes");
      const saved = yield* createNote(input);
      expect(saved.body).not.toContain(pendingId);
      yield* deleteNote(saved.id);
    }),
  );

  for (const operation of ["create", "update"] as const) {
    it.effect(`restores claimed uploads after a failed ${operation} database write`, () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const sql = yield* SqlClient.SqlClient;
        const input = {
          title: `Retry ${operation}`,
          body: "Before",
          tags: [],
          projectId: null,
          sourceThreadId: null,
          sourceMessageId: null,
        };
        const existing = operation === "update" ? yield* createNote(input) : null;
        const pendingId = `pending-00000000-0000-4000-8000-00000000000${operation === "create" ? "4" : "5"}`;
        const pendingPath = NodePath.join(config.attachmentsDir, `${pendingId}.png`);
        NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
        NodeFS.writeFileSync(pendingPath, "retry bytes");
        const filesBefore = NodeFS.readdirSync(config.attachmentsDir).sort();
        const body = `![Retry](t3-note-image://${pendingId})`;
        const save = existing ? updateNote({ ...existing, body }) : createNote({ ...input, body });
        if (operation === "create") {
          yield* sql`CREATE TRIGGER fail_note_write BEFORE INSERT ON notes BEGIN SELECT RAISE(ABORT, 'test write failure'); END`;
        } else {
          yield* sql`CREATE TRIGGER fail_note_write BEFORE UPDATE ON notes BEGIN SELECT RAISE(ABORT, 'test write failure'); END`;
        }
        const result = yield* save.pipe(
          Effect.result,
          Effect.ensuring(sql`DROP TRIGGER fail_note_write`.pipe(Effect.orDie)),
        );
        expect(result._tag).toBe("Failure");
        expect(NodeFS.readdirSync(config.attachmentsDir).sort()).toEqual(filesBefore);
        expect(NodeFS.readFileSync(pendingPath, "utf8")).toBe("retry bytes");
        if (existing) expect((yield* getNote(existing.id)).body).toBe("Before");
        const saved = yield* save;
        expect(saved.body).not.toContain(pendingId);
        expect(NodeFS.existsSync(pendingPath)).toBe(false);
        yield* deleteNote(saved.id);
      }),
    );
  }

  it.effect("stores project and transcript provenance, then searches, edits, and deletes", () =>
    Effect.gen(function* () {
      yield* seedProject(projectId, "/tmp/notes");
      yield* createThread(threadId);
      yield* writeReply(threadId, messageId, false);

      const note = yield* createNote({
        title: "First note",
        body: "Original body",
        tags: ["reference"],
        projectId,
        sourceThreadId: threadId,
        sourceMessageId: messageId,
      });
      expect(note.sourceThreadId).toBe(threadId);
      expect(note.sourceMessageId).toBe(messageId);
      expect((yield* listNotes({ query: "reference" })).notes.map((item) => item.id)).toEqual([
        note.id,
      ]);
      expect((yield* listNotes({ query: "Original body" })).notes[0]).not.toHaveProperty("body");
      const contextId = ComposerContextId.make(`note_${note.id}`);
      const text = `Use ${formatComposerContextReference({ kind: "note", contextId, label: note.title })}`;
      const command: OrchestrationV2Command = {
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("notes-command"),
        threadId,
        messageId: MessageId.make("notes-outgoing"),
        text,
        attachments: [],
        modelSelection: testModelSelection,
        dispatchMode: { type: "start_immediately" },
      };
      const sent = yield* snapshotNotesInCommand(command);
      if (sent.type !== "message.dispatch") throw new Error("Unexpected command");
      expect(sent.context?.records[0]).toMatchObject({ kind: "note", content: "Original body" });
      // The provider reads the note's text in the prompt, not just a reference to it.
      expect(projectComposerContextForProvider({ text, records: sent.context!.records })).toContain(
        "content:\nOriginal body",
      );
      // A launched thread's first message is snapshotted the same way.
      const launched = yield* snapshotNotesInMessage({ text, context: undefined });
      expect(launched?.records).toEqual(sent.context?.records);
      // Messages without a note reference pass through untouched.
      expect(yield* snapshotNotesInMessage({ text: "No notes here" })).toBeUndefined();
      const missing = yield* snapshotNotesInMessage({
        text: formatComposerContextReference({
          kind: "note",
          contextId: ComposerContextId.make("note_00000000-0000-4000-8000-000000000009"),
          label: "Gone",
        }),
      }).pipe(Effect.result);
      expect(missing._tag).toBe("Failure");

      const updated = yield* updateNote({
        id: note.id,
        title: "Renamed",
        body: "New body",
        tags: ["edited"],
        projectId: null,
      });
      expect(updated.projectId).toBeNull();
      expect(updated.sourceThreadId).toBe(threadId);
      expect(sent.context?.records[0]).toMatchObject({ content: "Original body" });
      expect((yield* getNote(note.id)).body).toBe("New body");
      yield* deleteNote(note.id);
      expect((yield* listNotes({})).notes).toEqual([]);
    }),
  );

  it.effect("saves a note from a pre-V2 transcript nobody opened since the upgrade", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const now = "2026-09-24T00:00:00.000Z";
      const legacyThreadId = ThreadId.make("notes-legacy-thread");
      const legacyMessageId = MessageId.make("notes-legacy-message");
      yield* seedProject(projectId, "/tmp/notes");
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
        VALUES (${legacyThreadId}, ${projectId}, 'Legacy', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', ${now}, ${now})`;
      yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, attachments_json, is_streaming, created_at, updated_at)
        VALUES
          (${legacyMessageId}, ${legacyThreadId}, 'assistant', 'Old', '[]', 0, ${now}, ${now}),
          ('notes-legacy-latest', ${legacyThreadId}, 'assistant', 'Newer', '[]', 0, '2026-09-25T00:00:00.000Z', '2026-09-25T00:00:00.000Z')`;
      // Startup imports the thread's shell with its latest message; the rest of the transcript
      // waits until something reads it.
      yield* importer.reconcileShells;
      const sourceInV2 = () =>
        sql<{ readonly message_id: string }>`
          SELECT message_id FROM orchestration_v2_projection_messages WHERE message_id = ${legacyMessageId}
        `.pipe(Effect.map((rows) => rows.length === 1));
      expect(yield* sourceInV2()).toBe(false);

      const note = yield* createNote({
        ...sourced(legacyThreadId, legacyMessageId),
        title: "From the old transcript",
      });
      expect(note.sourceMessageId).toBe(legacyMessageId);
      expect(yield* sourceInV2()).toBe(true);

      // The note keeps the source it was saved from even after that thread goes away.
      yield* threads.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("notes-legacy-delete"),
        threadId: legacyThreadId,
      });
      expect((yield* getNote(note.id)).sourceThreadId).toBe(legacyThreadId);
      yield* deleteNote(note.id);
    }),
  );

  it.effect("rejects sources that are unknown, deleted, unfinished, or from another project", () =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const otherProjectId = ProjectId.make("notes-other-project");
      const liveThreadId = ThreadId.make("notes-source-live");
      const deletedThreadId = ThreadId.make("notes-source-deleted");
      const finishedId = MessageId.make("notes-source-finished");
      const streamingId = MessageId.make("notes-source-streaming");
      yield* seedProject(projectId, "/tmp/notes");
      yield* seedProject(otherProjectId, "/tmp/notes-other");
      yield* createThread(liveThreadId);
      yield* createThread(deletedThreadId);
      yield* writeReply(liveThreadId, finishedId, false);
      yield* writeReply(liveThreadId, streamingId, true);
      yield* writeReply(deletedThreadId, MessageId.make("notes-source-gone"), false);
      yield* threads.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("notes-source-delete"),
        threadId: deletedThreadId,
      });

      const failure = (input: ReturnType<typeof sourced>) =>
        createNote(input).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        );
      const wrongThread = "Source thread does not belong to this project and environment.";
      const unfinished = "Source message is not complete on this environment.";
      expect(yield* failure(sourced(ThreadId.make("notes-source-unknown"), null))).toBe(
        wrongThread,
      );
      expect(yield* failure(sourced(deletedThreadId, MessageId.make("notes-source-gone")))).toBe(
        wrongThread,
      );
      expect(
        yield* failure({ ...sourced(liveThreadId, finishedId), projectId: otherProjectId }),
      ).toBe(wrongThread);
      expect(yield* failure(sourced(liveThreadId, streamingId))).toBe(unfinished);
      expect(yield* failure(sourced(liveThreadId, MessageId.make("notes-source-none")))).toBe(
        unfinished,
      );
      expect(yield* failure(sourced(null, finishedId))).toBe(unfinished);

      const saved = yield* createNote(sourced(liveThreadId, finishedId));
      yield* deleteNote(saved.id);
    }),
  );

  it.effect("keeps a queued message's other context when a text-only edit adds a note", () =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const queuedThreadId = ThreadId.make("notes-queued-thread");
      yield* seedProject(projectId, "/tmp/notes");
      yield* createThread(queuedThreadId);
      const note = yield* createNote({
        ...sourced(null, null),
        projectId: null,
        title: "Release checklist",
        body: "Bump the version.",
      });
      const mention = {
        version: 1 as const,
        kind: "mention" as const,
        contextId: ComposerContextId.make("mention_readme"),
        label: "README.md",
        path: "README.md",
      };
      const mentionRef = formatComposerContextReference(mention);
      const noteRef = formatComposerContextReference({
        kind: "note",
        contextId: ComposerContextId.make(`note_${note.id}`),
        label: note.title,
      });
      const send = (id: string, text: string, records?: ReadonlyArray<typeof mention>) => {
        const command: OrchestrationV2Command = {
          type: "message.dispatch",
          commandId: CommandId.make(id),
          createdBy: "user",
          creationSource: "web",
          threadId: queuedThreadId,
          messageId: MessageId.make(id),
          text,
          attachments: [],
          ...(records === undefined ? {} : { context: { version: 1, records: [...records] } }),
          modelSelection: testModelSelection,
          dispatchMode: { type: "start_immediately" },
        };
        return threads.dispatch(command);
      };
      yield* send("notes-queued-first", "Start");
      // The first run is still starting, so this one waits in the queue.
      yield* send("notes-queued-second", `Read ${mentionRef}`, [mention]);
      const queuedRun = (yield* threads.getThreadRecords(queuedThreadId, ["runs"])).runs.find(
        (run) => run.userMessageId === MessageId.make("notes-queued-second"),
      )!;
      expect(queuedRun.status).toBe("queued");

      // The client sends no context with an edit that has no attachments.
      const editCommand = {
        type: "queued-run.edit" as const,
        commandId: CommandId.make("notes-queued-edit"),
        threadId: queuedThreadId,
        runId: queuedRun.id,
        text: `Read ${mentionRef} and follow ${noteRef}`,
      };
      const edit = yield* snapshotNotesInCommand(editCommand);
      yield* threads.dispatch(edit);
      const edited = (yield* threads.getThreadRecords(queuedThreadId, ["messages"], {
        messageIds: [MessageId.make("notes-queued-second")],
      })).messages[0]!;
      expect(edited.context?.records).toEqual([
        mention,
        expect.objectContaining({ kind: "note", content: "Bump the version." }),
      ]);
      const prompt = projectComposerContextForProvider({
        text: edited.text,
        records: edited.context!.records,
      });
      expect(prompt).toContain("path: README.md");
      expect(prompt).toContain("content:\nBump the version.");
      expect(prompt).not.toContain('unavailable="true"');

      // Context the client does send stays authoritative.
      const explicit = yield* snapshotNotesInCommand({
        ...editCommand,
        context: { version: 1, records: [] },
      });
      expect(explicit.type === "queued-run.edit" && explicit.context?.records).toEqual([
        expect.objectContaining({ kind: "note" }),
      ]);
    }),
  );

  it.effect("claims note images into the server asset path", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const pendingId = "pending-00000000-0000-4000-8000-000000000001";
      NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`), "image bytes");
      const note = yield* createNote({
        title: "Image note",
        body: `![Image](t3-note-image://${pendingId})`,
        tags: [],
        projectId: null,
        sourceThreadId: null,
        sourceMessageId: null,
      });
      expect(note.body).not.toContain(pendingId);
      const attachmentId = /t3-note-image:\/\/([a-z0-9_-]+)/i.exec(note.body)?.[1];
      expect(attachmentId).toMatch(/^note-/);
      expect(NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${attachmentId}.png`))).toBe(
        true,
      );
    }),
  );
});
