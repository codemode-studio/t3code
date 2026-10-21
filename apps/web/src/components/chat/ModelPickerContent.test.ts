import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { partitionModelPickerProfileEntries } from "./ModelPickerContent";

function entry(status: ServerProvider["status"], driver = "opencode") {
  return deriveProviderInstanceEntries([
    {
      instanceId: ProviderInstanceId.make(`${driver}_work`),
      driver: ProviderDriverKind.make(driver),
      enabled: true,
      installed: true,
      version: null,
      status,
      auth: { status: "authenticated" },
      checkedAt: "2026-08-28T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ])[0]!;
}

describe("partitionModelPickerProfileEntries", () => {
  const entries = ["cc_a", "codex_a", "cc_b", "codex_b"].map((id) => ({
    ...entry("ready", "codex"),
    instanceId: ProviderInstanceId.make(id),
  }));
  const ids = (list: ReadonlyArray<{ instanceId: string }>) => list.map((item) => item.instanceId);
  const profile = {
    name: "Acme",
    instanceIdSet: new Set([ProviderInstanceId.make("codex_a"), ProviderInstanceId.make("cc_a")]),
  };

  it("lists only the profile's instances until others are revealed", () => {
    const hidden = partitionModelPickerProfileEntries({
      entries,
      profile,
      showOthers: false,
      activeInstanceId: ProviderInstanceId.make("cc_a"),
    });
    expect(ids(hidden.entries)).toEqual(["cc_a", "codex_a"]);
    expect([...hidden.outsideInstanceIds]).toEqual(["cc_b", "codex_b"]);

    const shown = partitionModelPickerProfileEntries({
      entries,
      profile,
      showOthers: true,
      activeInstanceId: ProviderInstanceId.make("cc_a"),
    });
    expect(ids(shown.entries)).toEqual(["cc_a", "codex_a", "cc_b", "codex_b"]);
  });

  it("keeps an active instance outside the profile reachable", () => {
    const result = partitionModelPickerProfileEntries({
      entries,
      profile,
      showOthers: false,
      activeInstanceId: ProviderInstanceId.make("codex_b"),
    });
    expect(ids(result.entries)).toEqual(["cc_a", "codex_a", "codex_b"]);
  });

  it("changes nothing without a profile", () => {
    const result = partitionModelPickerProfileEntries({
      entries,
      profile: null,
      showOthers: false,
      activeInstanceId: ProviderInstanceId.make("cc_b"),
    });
    expect(result.entries).toBe(entries);
    expect(result.outsideInstanceIds.size).toBe(0);
  });
});
