import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  MessageId,
  NoteError,
  ProjectId,
  ThreadId,
  type NoteCreateInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  NOTE_BODY_MAX_LENGTH,
  resolveNoteSource,
  saveTranscriptNote,
  transcriptNoteTitle,
  type TranscriptNoteTarget,
} from "./transcriptNote";

const environmentId = EnvironmentId.make("environment-local");
const fork = ThreadId.make("fork");
const parent = ThreadId.make("parent");
const messageId = MessageId.make("message-1");
const forkProject = ProjectId.make("fork-project");
const parentProject = ProjectId.make("parent-project");

function target(
  messageThreadId: ThreadId | undefined,
  displayedProjectId: ProjectId | null = forkProject,
): TranscriptNoteTarget {
  return { environmentId, displayedThreadId: fork, displayedProjectId, messageId, messageThreadId };
}

describe("resolveNoteSource", () => {
  it("credits an inherited message to the parent thread and project that own it", () => {
    expect(
      resolveNoteSource(target(parent), (threadId) =>
        threadId === parent ? parentProject : forkProject,
      ),
    ).toEqual({ projectId: parentProject, sourceThreadId: parent, sourceMessageId: messageId });
  });

  it("keeps the captured project but claims no source when the owner is gone", () => {
    expect(resolveNoteSource(target(parent), () => undefined)).toEqual({
      projectId: forkProject,
      sourceThreadId: null,
      sourceMessageId: null,
    });
  });

  it("claims nothing for the displayed thread once it is unknown or deleted", () => {
    expect(resolveNoteSource(target(fork, null), () => undefined)).toEqual({
      projectId: null,
      sourceThreadId: null,
      sourceMessageId: null,
    });
  });

  it("refuses a message the server has not persisted", () => {
    expect(resolveNoteSource(target(undefined), () => forkProject)).toBeNull();
  });
});

describe("saveTranscriptNote", () => {
  const saved: AtomCommandResult<unknown, unknown> = AsyncResult.success({});
  const refused = (message: string): AtomCommandResult<unknown, unknown> =>
    AsyncResult.failure(Cause.fail(new NoteError({ message })));

  function harness(results: ReadonlyArray<AtomCommandResult<unknown, unknown>>) {
    const calls: Array<NoteCreateInput> = [];
    const create = (note: NoteCreateInput) => {
      calls.push(note);
      return Promise.resolve(results[calls.length - 1] ?? saved);
    };
    return { calls, create };
  }

  it("saves with the owner's provenance", async () => {
    const { calls, create } = harness([saved]);
    const outcome = await saveTranscriptNote({
      target: target(parent),
      text: "## Plan\nStep one",
      threadProjectId: () => parentProject,
      create,
    });
    expect(outcome).toEqual({ _tag: "saved", title: "Plan" });
    expect(calls).toEqual([
      {
        title: "Plan",
        body: "## Plan\nStep one",
        tags: [],
        projectId: parentProject,
        sourceThreadId: parent,
        sourceMessageId: messageId,
      },
    ]);
  });

  it("keeps the text once, without associations, when the server refuses its source", async () => {
    const { calls, create } = harness([
      refused("Source thread does not belong to this project and environment."),
      saved,
    ]);
    const outcome = await saveTranscriptNote({
      target: target(parent),
      text: "Keep this",
      threadProjectId: () => parentProject,
      create,
    });
    expect(outcome._tag).toBe("saved");
    expect(
      calls.map(({ projectId, sourceThreadId, sourceMessageId }) => ({
        projectId,
        sourceThreadId,
        sourceMessageId,
      })),
    ).toEqual([
      { projectId: parentProject, sourceThreadId: parent, sourceMessageId: messageId },
      { projectId: null, sourceThreadId: null, sourceMessageId: null },
    ]);
  });

  it("retries at most once", async () => {
    const { calls, create } = harness([
      refused("Project was not found on this environment."),
      refused("Project was not found on this environment."),
    ]);
    const outcome = await saveTranscriptNote({
      target: target(parent),
      text: "Keep this",
      threadProjectId: () => parentProject,
      create,
    });
    expect(outcome).toEqual({
      _tag: "failed",
      detail: "Project was not found on this environment.",
    });
    expect(calls).toHaveLength(2);
  });

  it("does not retry other failures, which may have saved the note already", async () => {
    const { calls, create } = harness([
      AsyncResult.failure(Cause.fail(new Error("The connection closed before a reply."))),
    ]);
    const outcome = await saveTranscriptNote({
      target: target(parent),
      text: "Keep this",
      threadProjectId: () => parentProject,
      create,
    });
    expect(outcome).toEqual({ _tag: "failed", detail: "The connection closed before a reply." });
    expect(calls).toHaveLength(1);
  });

  it("sends nothing for an unsaved message or a body over the limit", async () => {
    const { calls, create } = harness([]);
    expect(
      await saveTranscriptNote({
        target: target(undefined),
        text: "Pending",
        threadProjectId: () => forkProject,
        create,
      }),
    ).toEqual({ _tag: "not-persisted" });
    expect(
      await saveTranscriptNote({
        target: target(parent),
        text: "x".repeat(NOTE_BODY_MAX_LENGTH + 1),
        threadProjectId: () => parentProject,
        create,
      }),
    ).toEqual({ _tag: "too-long" });
    expect(calls).toEqual([]);
  });
});

describe("transcriptNoteTitle", () => {
  it("uses the first line without heading marks", () => {
    expect(transcriptNoteTitle("\n## Plan\nStep one")).toBe("Plan");
    expect(transcriptNoteTitle("   ")).toBe("Transcript note");
  });
});
