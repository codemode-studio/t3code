import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
export function createNotesEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:notes:list",
    tag: WS_METHODS.notesList,
    staleTimeMs: 0,
  });
  const get = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:notes:get",
    tag: WS_METHODS.notesGet,
    staleTimeMs: 0,
  });
  return {
    list,
    get,
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:notes:create",
      tag: WS_METHODS.notesCreate,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(list({ environmentId, input: {} }))),
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:notes:update",
      tag: WS_METHODS.notesUpdate,
      onSuccess: ({ environmentId, input }, registry) =>
        Effect.sync(() => {
          registry.refresh(list({ environmentId, input: {} }));
          registry.refresh(get({ environmentId, input: { id: input.id } }));
        }),
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:notes:delete",
      tag: WS_METHODS.notesDelete,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(list({ environmentId, input: {} }))),
    }),
  };
}
