import { EnvironmentId, NoteId, type NoteSummary } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

vi.mock("../../lib/uuid", () => {
  let next = 0;
  return { uuidv4: () => `request-${++next}` };
});

import {
  attachPendingNoteToDraft,
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

it("attaches a queued note only to the draft of the project its request opened", () => {
  const environmentId = EnvironmentId.make("notes-server");
  const note: NoteSummary = {
    id: NoteId.make("routed-note"),
    title: "Routed",
    tags: [],
    projectId: null,
    sourceThreadId: null,
    sourceMessageId: null,
    createdAt: "2026-09-24",
    updatedAt: "2026-09-24",
  };
  const requestId = queueNoteForChat(environmentId, note);
  const routeProject = { environmentId, projectId: "project-b" };
  const inserted: Array<string> = [];
  const attach = (projectId: string, accept = true) =>
    attachPendingNoteToDraft({
      draftKey: `draft:${projectId}`,
      selectedProject: { environmentId, id: projectId },
      routeProject,
      requestId,
      insert: (draftKey) => {
        inserted.push(draftKey);
        return accept;
      },
    });

  // The flow still shows its previous project: wait, and keep the note queued.
  expect(attach("project-a")).toBe("waiting");
  expect(inserted).toEqual([]);
  // The draft refuses it (too much context): report it and keep it queued.
  expect(attach("project-b", false)).toBe("rejected");
  expect(pendingNoteForChat(environmentId, requestId)).toEqual(note);
  // Once the route's project is selected the note lands there, exactly once.
  expect(attach("project-b")).toBe("attached");
  expect(attach("project-b")).toBe("waiting");
  expect(inserted).toEqual(["draft:project-b", "draft:project-b"]);
  expect(pendingNoteForChat(environmentId, requestId)).toBeNull();
});
