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
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { layerTest as testServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  createNote,
  deleteNote,
  getNote,
  listNotes,
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
