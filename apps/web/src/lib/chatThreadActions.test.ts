import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveNewThreadModelSelectionOverride } from "./chatThreadActions";

const PROJECT_DEFAULT_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "project-default",
};
const CARRIED_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "carried-model",
};

describe("chatThreadActions", () => {
  it("does not carry a non-explicit model from the destination draft back into itself", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: null,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-a",
      }),
    ).toBeNull();
  });

  it("drops a carried outside provider when a new thread starts in a profiled project", () => {
    // The viewed thread in another project runs on an instance the target
    // project's profile does not include.
    const outsideSelection: ModelSelection = {
      instanceId: ProviderInstanceId.make("cc_b"),
      model: "opus",
    };
    const providerProfile = { instanceIdSet: new Set([ProviderInstanceId.make("cc_a")]) };
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: null,
        carrySelection: outsideSelection,
        carrySourceDraftId: "draft-other-project",
        destinationDraftId: "draft-b",
        providerProfile,
      }),
    ).toBeNull();
    const insideSelection = { ...outsideSelection, instanceId: ProviderInstanceId.make("cc_a") };
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: null,
        carrySelection: insideSelection,
        carrySourceDraftId: "draft-other-project",
        destinationDraftId: "draft-b",
        providerProfile,
      }),
    ).toEqual(insideSelection);
  });

  it("keeps the project default above any carried selection", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: PROJECT_DEFAULT_SELECTION,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-b",
      }),
    ).toEqual(PROJECT_DEFAULT_SELECTION);
  });
});
