import { EnvironmentId, NoteId, type NoteSummary } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

vi.mock("../../lib/uuid", () => {
  let next = 0;
  return { uuidv4: () => `request-${++next}` };
});

import {
  clearPendingNoteForChat,
  pendingNoteForChat,
  queueNoteForChat,
} from "./pendingNoteForChat";

it("only inserts a queued note into the draft opened by that Add to chat request", () => {
  const environmentId = EnvironmentId.make("notes-server");
  const note: NoteSummary = {
    id: NoteId.make("note"),
    title: "Reference",
    tags: [],
    projectId: null,
    sourceThreadId: null,
    sourceMessageId: null,
    createdAt: "2026-09-24",
    updatedAt: "2026-09-24",
  };
  const abandonedRequest = queueNoteForChat(environmentId, note);
  expect(pendingNoteForChat(environmentId, undefined)).toBeNull();
  const nextRequest = queueNoteForChat(environmentId, note);
  expect(pendingNoteForChat(environmentId, abandonedRequest)).toBeNull();
  expect(pendingNoteForChat(EnvironmentId.make("another-server"), nextRequest)).toBeNull();
  expect(pendingNoteForChat(environmentId, nextRequest)).toEqual(note);
  clearPendingNoteForChat(environmentId, note.id);
  expect(pendingNoteForChat(environmentId, nextRequest)).toBeNull();
});
