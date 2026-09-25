import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  NoteId,
  NoteError,
  WS_METHODS,
  type Note,
  type NoteListInput,
  type NoteUpdateInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createNotesEnvironmentAtoms } from "./notes.ts";

function waitFor<A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  predicate: (value: A) => boolean,
) {
  return AtomRegistry.toStream(registry, atom).pipe(
    Stream.filter(
      (result) => AsyncResult.isSuccess(result) && !result.waiting && predicate(result.value),
    ),
    Stream.runHead,
  );
}

it.effect(
  "refreshes mounted lists, searches and details in another client after edits and deletion",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const environmentId = EnvironmentId.make("notes-server");
        const revision = yield* SubscriptionRef.make(0);
        let note: Note | null = {
          id: NoteId.make("00000000-0000-4000-8000-000000000001"),
          title: "Original",
          body: "First body",
          tags: [],
          projectId: null,
          sourceThreadId: null,
          sourceMessageId: null,
          createdAt: "2026-09-24T00:00:00Z",
          updatedAt: "2026-09-24T00:00:00Z",
        };
        const id = note.id;
        const client = {
          [WS_METHODS.notesSubscribeChanges]: () => SubscriptionRef.changes(revision),
          [WS_METHODS.notesList]: (input: NoteListInput) =>
            Effect.sync(() => ({
              notes: note && (!input.query || note.title.includes(input.query)) ? [note] : [],
            })),
          [WS_METHODS.notesGet]: () =>
            Effect.suspend(() =>
              note ? Effect.succeed(note) : Effect.fail(new NoteError({ message: "Deleted" })),
            ),
          [WS_METHODS.notesUpdate]: (input: NoteUpdateInput) =>
            Effect.gen(function* () {
              note = { ...note!, ...input };
              yield* SubscriptionRef.update(revision, (value) => value + 1);
              return note;
            }),
          [WS_METHODS.notesDelete]: () =>
            Effect.gen(function* () {
              note = null;
              yield* SubscriptionRef.update(revision, (value) => value + 1);
            }),
        } as unknown as WsRpcProtocolClient;
        const session: RpcSession = {
          client,
          initialConfig: Effect.never,
          subscribeServerConfig: (input) => client.subscribeServerConfig(input),
          ready: Effect.void,
          probe: Effect.void,
          closed: Effect.never,
        };
        const supervisor = EnvironmentSupervisor.of({
          target: new PrimaryConnectionTarget({
            environmentId,
            label: "Notes",
            httpBaseUrl: "https://notes.test",
            wsBaseUrl: "wss://notes.test",
          }),
          state: yield* SubscriptionRef.make<SupervisorConnectionState>({
            ...AVAILABLE_CONNECTION_STATE,
            phase: "connected",
          }),
          session: yield* SubscriptionRef.make(Option.some(session)),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        });
        const environments = EnvironmentRegistry.of({
          run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
          followStream: (_id, stream) =>
            Stream.provideService(stream, EnvironmentSupervisor, supervisor),
        } as EnvironmentRegistry["Service"]);
        const atoms = createNotesEnvironmentAtoms(
          Atom.runtime(Layer.succeed(EnvironmentRegistry, environments)),
        );
        const first = AtomRegistry.make();
        const second = AtomRegistry.make();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            first.dispose();
            second.dispose();
          }),
        );
        const list = atoms.list({ environmentId, input: {} });
        const search = atoms.list({ environmentId, input: { query: "Original" } });
        const detail = atoms.get({ environmentId, input: { id } });
        const unmounts = [second.mount(list), second.mount(search), second.mount(detail)];
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => unmounts.forEach((unmount) => unmount())),
        );
        yield* waitFor(second, list, (value) => value.notes[0]?.title === "Original");
        yield* waitFor(second, search, (value) => value.notes.length === 1);
        yield* waitFor(second, detail, (value) => value.body === "First body");
        const result = yield* Effect.promise(() =>
          atoms.update.run(first, {
            environmentId,
            input: { id, title: "Edited", body: "Second body", tags: [], projectId: null },
          }),
        );
        expect(AsyncResult.isSuccess(result)).toBe(true);
        yield* waitFor(second, list, (value) => value.notes[0]?.title === "Edited");
        yield* waitFor(second, search, (value) => value.notes.length === 0);
        yield* waitFor(second, detail, (value) => value.body === "Second body");
        yield* Effect.promise(() => atoms.remove.run(first, { environmentId, input: { id } }));
        yield* waitFor(second, list, (value) => value.notes.length === 0);
        const deleted = yield* AtomRegistry.toStream(second, detail).pipe(
          Stream.filter(AsyncResult.isFailure),
          Stream.runHead,
        );
        expect(Option.isSome(deleted)).toBe(true);
      }),
    ),
);
