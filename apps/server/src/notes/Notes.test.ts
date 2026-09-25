// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ComposerContextId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { layerTest as testServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  createNote,
  deleteNote,
  getNote,
  listNotes,
  makeNotes,
  snapshotNotesInCommand,
  updateNote,
} from "./Notes.ts";

const projectId = ProjectId.make("notes-project");
const threadId = ThreadId.make("notes-thread");
const messageId = MessageId.make("notes-message");
const testLayer = Layer.mergeAll(
  SqlitePersistenceMemory,
  testServerConfig(process.cwd(), { prefix: "t3-notes-test-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

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
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-24T00:00:00.000Z";
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES (${projectId}, 'Project', '/tmp/notes', '[]', ${now}, ${now})`;
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, created_at, updated_at)
        VALUES (${threadId}, ${projectId}, 'Thread', '{}', ${now}, ${now})`;
      yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES (${messageId}, ${threadId}, 'assistant', 'Source', 0, ${now}, ${now})`;

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
      const command = {
        type: "thread.turn.start",
        commandId: CommandId.make("notes-command"),
        threadId,
        message: {
          messageId: MessageId.make("notes-outgoing"),
          role: "user",
          text: formatComposerContextReference({ kind: "note", contextId, label: note.title }),
          attachments: [],
        },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: now,
      } as OrchestrationCommand;
      const sent = yield* snapshotNotesInCommand(command);
      if (sent.type !== "thread.turn.start") throw new Error("Unexpected command");
      expect(sent.message.context?.records[0]).toMatchObject({
        kind: "note",
        content: "Original body",
      });

      const updated = yield* updateNote({
        id: note.id,
        title: "Renamed",
        body: "New body",
        tags: ["edited"],
        projectId: null,
      });
      expect(updated.projectId).toBeNull();
      expect(updated.sourceThreadId).toBe(threadId);
      expect(sent.message.context?.records[0]).toMatchObject({ content: "Original body" });
      expect((yield* getNote(note.id)).body).toBe("New body");
      yield* deleteNote(note.id);
      expect((yield* listNotes({})).notes).toEqual([]);
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
