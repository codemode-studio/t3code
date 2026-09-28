import {
  EnvironmentId,
  ProjectId,
  ProviderProfileId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProjectProfileMap,
  collectProfiles,
  profileMonogram,
  resolveProfileScope,
  resolveProjectProfileId,
  scopedProjectKeysForProfile,
} from "./profileScope";

const primary = EnvironmentId.make("env-primary");
const remote = EnvironmentId.make("env-remote");
const acme = ProviderProfileId.make("acme");
const globex = ProviderProfileId.make("globex");
const api = ProjectId.make("project-api");
const web = ProjectId.make("project-web");
const dotfiles = ProjectId.make("project-dotfiles");

type ProfileSettings = Pick<
  ServerSettings,
  "providerProfileId" | "providerProfiles" | "projectSettingsOverrides"
>;

function settings(overrides: Partial<ProfileSettings> = {}): ProfileSettings {
  return {
    providerProfileId: null,
    providerProfiles: {
      [acme]: { name: "Acme", color: "#2563eb", instanceIds: [], defaultModelSelection: null },
      [globex]: { name: "Globex", instanceIds: [], defaultModelSelection: null },
    },
    projectSettingsOverrides: {},
    ...overrides,
  };
}

describe("resolveProjectProfileId", () => {
  it("prefers the project's override, including an explicit no-profile", () => {
    const base = settings({
      providerProfileId: acme,
      projectSettingsOverrides: {
        [api]: { providerProfileId: globex },
        [web]: { providerProfileId: null },
      },
    });
    expect(resolveProjectProfileId(base, api)).toBe(globex);
    expect(resolveProjectProfileId(base, web)).toBeNull();
    expect(resolveProjectProfileId(base, dotfiles)).toBe(acme);
  });

  it("treats a deleted profile as no profile", () => {
    const base = settings({
      projectSettingsOverrides: { [api]: { providerProfileId: ProviderProfileId.make("gone") } },
    });
    expect(resolveProjectProfileId(base, api)).toBeNull();
  });
});

describe("collectProfiles", () => {
  it("merges profiles by id, named by the primary environment, sorted by name", () => {
    const renamed = settings();
    const remoteSettings: Pick<ServerSettings, "providerProfiles"> = {
      providerProfiles: {
        [acme]: { name: "Acme (old name)", instanceIds: [], defaultModelSelection: null },
        [ProviderProfileId.make("initech")]: {
          name: "Initech",
          instanceIds: [],
          defaultModelSelection: null,
        },
      },
    };
    const profiles = collectProfiles(
      [
        [remote, remoteSettings],
        [primary, renamed],
      ],
      primary,
    );
    expect(profiles.map((profile) => profile.name)).toEqual(["Acme", "Globex", "Initech"]);
    expect(profiles[0]?.color).toBe("#2563eb");
    expect(profiles[1]?.color).toBeNull();
  });
});

describe("profile scopes", () => {
  const projectProfiles = buildProjectProfileMap(
    [
      { environmentId: primary, id: api },
      { environmentId: primary, id: dotfiles },
      { environmentId: remote, id: web },
    ],
    new Map([
      [primary, settings({ projectSettingsOverrides: { [api]: { providerProfileId: acme } } })],
      [remote, settings({ providerProfileId: acme })],
    ]),
  );

  it("filters projects to a profile, to the unassigned bucket, or not at all", () => {
    expect(scopedProjectKeysForProfile("all", projectProfiles)).toBeNull();
    expect([...(scopedProjectKeysForProfile(acme, projectProfiles) ?? [])]).toEqual([
      `${primary}:${api}`,
      `${remote}:${web}`,
    ]);
    expect([...(scopedProjectKeysForProfile("unassigned", projectProfiles) ?? [])]).toEqual([
      `${primary}:${dotfiles}`,
    ]);
  });

  it("falls back to every project while a stored profile is not defined anywhere", () => {
    const profiles = collectProfiles([[primary, settings()]], primary);
    expect(resolveProfileScope("acme", profiles)).toBe(acme);
    expect(resolveProfileScope("unassigned", profiles)).toBe("unassigned");
    expect(resolveProfileScope("initech", profiles)).toBe("all");
    expect(resolveProfileScope("acme", [])).toBe("all");
  });
});

describe("profileMonogram", () => {
  it("uses word initials, else the first two letters", () => {
    expect(profileMonogram("Silver Orchard")).toBe("SO");
    expect(profileMonogram("spendle")).toBe("SP");
    expect(profileMonogram(" ")).toBe("?");
  });
});
