import { MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveNoteSource } from "./noteSource";

const fork = ThreadId.make("fork");
const parent = ThreadId.make("parent");
const messageId = MessageId.make("message-1");
const forkProject = ProjectId.make("fork-project");
const parentProject = ProjectId.make("parent-project");

describe("resolveNoteSource", () => {
  it("credits an inherited message to the parent thread that owns it", () => {
    expect(
      resolveNoteSource({
        messageId,
        messageThreadId: parent,
        displayedThreadId: fork,
        displayedProjectId: forkProject,
        threadProjectId: (threadId) => (threadId === parent ? parentProject : forkProject),
      }),
    ).toEqual({ projectId: parentProject, sourceThreadId: parent, sourceMessageId: messageId });
  });

  it("keeps the text but drops provenance when the parent is gone", () => {
    expect(
      resolveNoteSource({
        messageId,
        messageThreadId: parent,
        displayedThreadId: fork,
        displayedProjectId: forkProject,
        threadProjectId: (threadId) => (threadId === fork ? forkProject : undefined),
      }),
    ).toEqual({ projectId: forkProject, sourceThreadId: null, sourceMessageId: null });
  });

  it("refuses messages that are not persisted in the displayed timeline", () => {
    expect(
      resolveNoteSource({
        messageId,
        messageThreadId: undefined,
        displayedThreadId: fork,
        displayedProjectId: forkProject,
        threadProjectId: () => forkProject,
      }),
    ).toBeNull();
  });
});
