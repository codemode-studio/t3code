import type { ProfileScopeProfile } from "@t3tools/client-runtime/state/profile-scope";
import { ProviderProfileId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildHomeProfileFilterOptions } from "./home-profile-scope";

const acme = ProviderProfileId.make("acme");
const globex = ProviderProfileId.make("globex");
const profiles: ReadonlyArray<ProfileScopeProfile> = [
  { id: acme, name: "Acme", color: "#ea580c" },
  { id: globex, name: "Globex", color: null },
];

describe("buildHomeProfileFilterOptions", () => {
  it("hides the filter when no environment defines a profile", () => {
    expect(buildHomeProfileFilterOptions({ profiles: [], hasUnassignedProjects: true })).toEqual(
      [],
    );
  });

  it("lists each profile with its color and adds Unassigned only when a project has none", () => {
    expect(buildHomeProfileFilterOptions({ profiles, hasUnassignedProjects: false })).toEqual([
      { scope: "profile:acme", label: "Acme", color: "#ea580c" },
      { scope: "profile:globex", label: "Globex", color: null },
    ]);
    expect(
      buildHomeProfileFilterOptions({ profiles, hasUnassignedProjects: true }).map(
        (option) => option.scope,
      ),
    ).toEqual(["profile:acme", "profile:globex", "unassigned"]);
  });
});
