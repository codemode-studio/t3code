import { EnvironmentId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveNoteSource,
  transcriptNoteTitle,
  type TranscriptNoteTarget,
} from "./transcriptNote";

const environmentId = EnvironmentId.make("environment-local");
const fork = ThreadId.make("fork");
const parent = ThreadId.make("parent");
const messageId = MessageId.make("message-1");
const forkProject = ProjectId.make("fork-project");
const parentProject = ProjectId.make("parent-project");

function target(messageThreadId: ThreadId | undefined): TranscriptNoteTarget {
  return { environmentId, displayedThreadId: fork, messageId, messageThreadId };
}

describe("resolveNoteSource", () => {
  it("credits an inherited message to the parent thread and project that own it", () => {
    expect(
      resolveNoteSource(target(parent), (threadId) =>
        threadId === parent ? parentProject : forkProject,
      ),
    ).toEqual({ projectId: parentProject, sourceThreadId: parent, sourceMessageId: messageId });
  });

  it("credits the thread's own message to that thread", () => {
    expect(resolveNoteSource(target(fork), () => forkProject)).toEqual({
      projectId: forkProject,
      sourceThreadId: fork,
      sourceMessageId: messageId,
    });
  });

  it("keeps the text but drops provenance when the parent is deleted or unknown", () => {
    expect(
      resolveNoteSource(target(parent), (threadId) =>
        threadId === fork ? forkProject : undefined,
      ),
    ).toEqual({ projectId: forkProject, sourceThreadId: null, sourceMessageId: null });
  });

  it("refuses a message the server has not persisted", () => {
    expect(resolveNoteSource(target(undefined), () => forkProject)).toBeNull();
  });

  it("resolves from the captured target, whatever thread is shown later", () => {
    const asked: Array<ThreadId> = [];
    resolveNoteSource(target(parent), (threadId) => {
      asked.push(threadId);
      return parentProject;
    });
    expect(asked).toEqual([parent]);
  });
});

describe("transcriptNoteTitle", () => {
  it("uses the first line without heading marks", () => {
    expect(transcriptNoteTitle("\n## Plan\nStep one")).toBe("Plan");
    expect(transcriptNoteTitle("   ")).toBe("Transcript note");
  });
});
