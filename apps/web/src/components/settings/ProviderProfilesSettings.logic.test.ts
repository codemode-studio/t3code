import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderProfileId,
  type ServerSettings,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { describe, expect, it } from "vite-plus/test";

import {
  buildDeleteProviderProfilePatch,
  decodeProviderProfileValue,
  encodeProviderProfileValue,
  NO_PROVIDER_PROFILE_VALUE,
  providerProfileIdFromName,
  resolveProjectProviderProfileId,
} from "./ProviderProfilesSettings.logic";

const acme = ProviderProfileId.make("acme");
const globex = ProviderProfileId.make("globex");
const optedIn = ProjectId.make("opted-in");
const optedOut = ProjectId.make("opted-out");
const other = ProjectId.make("other");
const inheriting = ProjectId.make("inheriting");

const settings: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerProfileId: acme,
  providerProfiles: {
    [acme]: { name: "Acme", instanceIds: [], defaultModelSelection: null },
    [globex]: { name: "Globex", instanceIds: [], defaultModelSelection: null },
  },
  projectSettingsOverrides: {
    [optedIn]: { providerProfileId: acme, defaultRuntimeMode: "approval-required" },
    [optedOut]: { providerProfileId: null },
    [other]: { providerProfileId: globex },
  },
};

describe("providerProfileIdFromName", () => {
  it("slugs the name and avoids existing ids", () => {
    expect(providerProfileIdFromName("  Acme Corp! ", {})).toBe("acme-corp");
    expect(providerProfileIdFromName("Acme", { acme: {}, "acme-2": {} })).toBe("acme-3");
    expect(providerProfileIdFromName("Café", {})).toBe("cafe");
    expect(providerProfileIdFromName("!!!", {})).toBe("profile");
  });
});

describe("buildDeleteProviderProfilePatch", () => {
  it("removes the profile along with the environment default and overrides that select it", () => {
    const next = applyServerSettingsPatch(
      settings,
      buildDeleteProviderProfilePatch(settings, acme),
    );
    expect(Object.keys(next.providerProfiles)).toEqual([globex]);
    expect(next.providerProfileId).toBeNull();
    expect(next.projectSettingsOverrides).toEqual({
      [optedIn]: { defaultRuntimeMode: "approval-required" },
      [optedOut]: { providerProfileId: null },
      [other]: { providerProfileId: globex },
    });
  });

  it("leaves an unrelated environment default alone", () => {
    const patch = buildDeleteProviderProfilePatch(settings, globex);
    expect(patch).not.toHaveProperty("providerProfileId");
    expect(applyServerSettingsPatch(settings, patch).projectSettingsOverrides).not.toHaveProperty(
      other,
    );
  });
});

describe("resolveProjectProviderProfileId", () => {
  it("prefers the project's override, including an explicit opt-out", () => {
    expect(resolveProjectProviderProfileId(settings, other)).toBe(globex);
    expect(resolveProjectProviderProfileId(settings, optedOut)).toBeNull();
    expect(resolveProjectProviderProfileId(settings, inheriting)).toBe(acme);
  });
});

describe("provider profile select values", () => {
  it("keeps a profile named None distinct from the opt-out", () => {
    const noneProfile = providerProfileIdFromName("None", {});
    expect(noneProfile).toBe("none");
    const value = encodeProviderProfileValue(noneProfile);
    expect(value).not.toBe(NO_PROVIDER_PROFILE_VALUE);
    expect(decodeProviderProfileValue(value)).toBe(noneProfile);
    expect(decodeProviderProfileValue(encodeProviderProfileValue(null))).toBeNull();
    // Ids are slugs, so even one spelled like the opt-out value stays a profile.
    const lookalike = providerProfileIdFromName("No profile", {});
    expect(decodeProviderProfileValue(encodeProviderProfileValue(lookalike))).toBe(lookalike);
    expect(decodeProviderProfileValue("none")).toBeUndefined();
  });
});
