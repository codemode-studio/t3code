import { useAtomValue } from "@effect/atom-react";
import { createNotesEnvironmentAtoms } from "@t3tools/client-runtime/state/notes";
import type { EnvironmentId, NoteSummary } from "@t3tools/contracts";
import { isAnswerExpected } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentPresentations } from "./presentation";

export const notesEnvironment = createNotesEnvironmentAtoms(connectionAtomRuntime);
export interface EnvironmentNote extends NoteSummary {
  readonly environmentId: EnvironmentId;
}

const allNotesAtom = Atom.family((query: string) =>
  Atom.make((get) => {
    const notes: EnvironmentNote[] = [];
    let isPending = false;
    for (const [environmentId, presentation] of get(environmentPresentations.presentationsAtom)) {
      const result = get(notesEnvironment.list({ environmentId, input: query ? { query } : {} }));
      const value = Option.getOrNull(AsyncResult.value(result));
      if (value === null) {
        isPending ||= result._tag !== "Failure" && isAnswerExpected(presentation);
        continue;
      }
      notes.push(...value.notes.map((note) => ({ ...note, environmentId })));
    }
    notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { notes, isPending };
  }).pipe(Atom.withLabel(`mobile-notes:${query}`)),
);

export function useNotes(query = "") {
  return useAtomValue(allNotesAtom(query.slice(0, 200)));
}
