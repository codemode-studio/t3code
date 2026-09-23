/**
 * Automations from every connected environment. Each environment owns and runs its own
 * automations; the page merges them into one list.
 *
 * @module state/automations
 */
import { useAtomValue } from "@effect/atom-react";
import { type Automation, type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentPresentations } from "./presentation";

export interface EnvironmentAutomation extends Automation {
  readonly environmentId: EnvironmentId;
}

const automationsByEnvironment = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:automations",
  tag: WS_METHODS.subscribeAutomations,
});

export const createAutomation = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:automations:create",
  tag: WS_METHODS.automationsCreate,
});

export const updateAutomation = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:automations:update",
  tag: WS_METHODS.automationsUpdate,
});

export const deleteAutomation = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:automations:delete",
  tag: WS_METHODS.automationsDelete,
});

export const runAutomationNow = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:automations:run-now",
  tag: WS_METHODS.automationsRunNow,
});

interface AutomationsView {
  readonly automations: readonly EnvironmentAutomation[];
  /** True until every environment has answered at least once. */
  readonly isPending: boolean;
}

const allAutomationsAtom = Atom.make((get): AutomationsView => {
  const automations: EnvironmentAutomation[] = [];
  let isPending = false;
  for (const environmentId of get(environmentPresentations.presentationsAtom).keys()) {
    const result = get(automationsByEnvironment({ environmentId, input: {} }));
    const snapshot = Option.getOrNull(AsyncResult.value(result));
    if (snapshot === null) {
      isPending ||= result._tag !== "Failure";
      continue;
    }
    for (const automation of snapshot.automations) {
      automations.push({ ...automation, environmentId });
    }
  }
  automations.sort((a, b) => a.name.localeCompare(b.name));
  return { automations, isPending };
}).pipe(Atom.withLabel("web-automations:all"));

export function useAutomations(): AutomationsView {
  return useAtomValue(allAutomationsAtom);
}
