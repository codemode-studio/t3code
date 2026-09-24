import { useAtomValue } from "@effect/atom-react";
import { createNotesEnvironmentAtoms } from "@t3tools/client-runtime/state/notes";
import type { EnvironmentId, NoteSummary } from "@t3tools/contracts";
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
    for (const environmentId of get(environmentPresentations.presentationsAtom).keys()) {
      const result = get(notesEnvironment.list({ environmentId, input: query ? { query } : {} }));
      const snapshot = Option.getOrNull(AsyncResult.value(result));
      if (snapshot === null) {
        isPending ||= result._tag !== "Failure";
        continue;
      }
      notes.push(...snapshot.notes.map((note) => ({ ...note, environmentId })));
    }
    notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { notes, isPending };
  }).pipe(Atom.withLabel(`web-notes:${query}`)),
);

export function useNotes(query = "") {
  return useAtomValue(allNotesAtom(query.slice(0, 200)));
}
