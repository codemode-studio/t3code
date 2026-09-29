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
  followNavigation,
  hasProjectsWithoutProfile,
  intersectProjectKeys,
  profileMonogram,
  profileScopeForId,
  resolveProfileScope,
  resolveProjectProfileId,
  scopedProjectKeysForProfile,
  type ProfileNavigation,
  type ProfileScope,
} from "./profileScope.ts";

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
  it("merges profiles by id, named and ordered by the primary environment", () => {
    const base = settings();
    // Settings order, as the Profiles page lists them, not alphabetical.
    const renamed = settings({
      providerProfiles: {
        [globex]: base.providerProfiles[globex]!,
        [acme]: base.providerProfiles[acme]!,
      },
    });
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
    expect(profiles.map((profile) => profile.name)).toEqual(["Globex", "Acme", "Initech"]);
    expect(profiles[0]?.color).toBeNull();
    expect(profiles[1]?.color).toBe("#2563eb");
    expect(profiles.map((profile) => profile.environmentIds)).toEqual([
      [primary],
      [primary, remote],
      [remote],
    ]);
  });
});

describe("hasProjectsWithoutProfile", () => {
  const withoutProfiles = settings({ providerProfiles: {} });

  it("ignores projects on environments that define no profiles", () => {
    expect(
      hasProjectsWithoutProfile(
        [
          { environmentId: primary, id: api },
          { environmentId: remote, id: web },
        ],
        new Map([
          [primary, settings({ providerProfileId: acme })],
          [remote, withoutProfiles],
        ]),
      ),
    ).toBe(false);
  });

  it("counts a project without a profile where profiles are set up", () => {
    expect(
      hasProjectsWithoutProfile(
        [{ environmentId: primary, id: api }],
        new Map([[primary, settings()]]),
      ),
    ).toBe(true);
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
    expect([
      ...(scopedProjectKeysForProfile(profileScopeForId(acme), projectProfiles) ?? []),
    ]).toEqual([`${primary}:${api}`, `${remote}:${web}`]);
    expect([...(scopedProjectKeysForProfile("unassigned", projectProfiles) ?? [])]).toEqual([
      `${primary}:${dotfiles}`,
    ]);
  });

  it("falls back to every project while a stored profile is not defined anywhere", () => {
    const profiles = collectProfiles([[primary, settings()]], primary);
    expect(resolveProfileScope("profile:acme", profiles, true)).toBe("profile:acme");
    expect(resolveProfileScope("profile:initech", profiles, true)).toBe("all");
    expect(resolveProfileScope("profile:acme", [], true)).toBe("all");
    // A bare id, as stored before profile values were tagged, is not a profile choice.
    expect(resolveProfileScope("acme", profiles, true)).toBe("all");
  });

  it("shows everything once the last unassigned project gets a profile, keeping the choice", () => {
    const profiles = collectProfiles([[primary, settings()]], primary);
    expect(resolveProfileScope("unassigned", profiles, true)).toBe("unassigned");
    expect(resolveProfileScope("unassigned", profiles, false)).toBe("all");
  });

  it("keeps profiles named All and Unassigned apart from the special scopes", () => {
    const named = ProviderProfileId.make("all");
    const unassignedNamed = ProviderProfileId.make("unassigned");
    const namedSettings = settings({
      providerProfiles: {
        [named]: { name: "All", instanceIds: [], defaultModelSelection: null },
        [unassignedNamed]: { name: "Unassigned", instanceIds: [], defaultModelSelection: null },
      },
      projectSettingsOverrides: {
        [api]: { providerProfileId: named },
        [web]: { providerProfileId: unassignedNamed },
      },
    });
    const profiles = collectProfiles([[primary, namedSettings]], primary);
    const map = buildProjectProfileMap(
      [
        { environmentId: primary, id: api },
        { environmentId: primary, id: web },
        { environmentId: primary, id: dotfiles },
      ],
      new Map([[primary, namedSettings]]),
    );
    const allScope = resolveProfileScope(profileScopeForId(named), profiles, true);
    const unassignedScope = resolveProfileScope(profileScopeForId(unassignedNamed), profiles, true);
    expect(allScope).toBe("profile:all");
    expect(unassignedScope).toBe("profile:unassigned");
    expect([...(scopedProjectKeysForProfile(allScope, map) ?? [])]).toEqual([`${primary}:${api}`]);
    expect([...(scopedProjectKeysForProfile(unassignedScope, map) ?? [])]).toEqual([
      `${primary}:${web}`,
    ]);
    expect([...(scopedProjectKeysForProfile("unassigned", map) ?? [])]).toEqual([
      `${primary}:${dotfiles}`,
    ]);
  });

  it("keeps only the profile's members of a project grouped across environments", () => {
    // One repository checked out on two machines, each assigned to a different profile.
    const group = new Set([`${primary}:${api}`, `${remote}:${web}`]);
    const map = buildProjectProfileMap(
      [
        { environmentId: primary, id: api },
        { environmentId: remote, id: web },
      ],
      new Map([
        [primary, settings({ projectSettingsOverrides: { [api]: { providerProfileId: acme } } })],
        [remote, settings({ projectSettingsOverrides: { [web]: { providerProfileId: globex } } })],
      ]),
    );
    const acmeKeys = scopedProjectKeysForProfile(profileScopeForId(acme), map);
    expect([...(intersectProjectKeys(group, acmeKeys) ?? [])]).toEqual([`${primary}:${api}`]);
    expect(intersectProjectKeys(group, null)).toBe(group);
    expect(intersectProjectKeys(null, acmeKeys)).toBe(acmeKeys);
  });
});

describe("profileMonogram", () => {
  it("uses word initials, else the first two letters", () => {
    expect(profileMonogram("Silver Orchard")).toBe("SO");
    expect(profileMonogram("spendle")).toBe("SP");
    expect(profileMonogram(" ")).toBe("?");
  });
});

describe("followNavigation", () => {
  const projectProfiles = new Map([
    [`${primary}:${api}`, acme],
    [`${primary}:${web}`, globex],
  ]);
  const at = (routeKey: string, projectId: ProjectId): ProfileNavigation => ({
    routeKey,
    projectKey: `${primary}:${projectId}`,
  });
  const step = (
    followed: ProfileNavigation | null,
    current: ProfileNavigation,
    scope: ProfileScope,
  ) => followNavigation({ followed, current, scope, projectProfiles });

  it("switches on navigation and keeps a manual choice until the next one", () => {
    const acmeScope = profileScopeForId(acme);
    const globexScope = profileScopeForId(globex);
    const firstThread = at("thread-a1", api);
    // Opening an Acme thread while Globex shows switches to Acme.
    expect(step(null, firstThread, globexScope)).toEqual({ kind: "switch", scope: acmeScope });
    // Picking Globex by hand on the same thread holds.
    expect(step(firstThread, firstThread, globexScope)).toEqual({ kind: "stay" });
    // Opening another thread of the same Acme project from search or a notification switches back.
    expect(step(firstThread, at("thread-a2", api), globexScope)).toEqual({
      kind: "switch",
      scope: acmeScope,
    });
    // Moving a draft to a Globex project follows it too.
    expect(step(at("draft-1", api), at("draft-1", web), acmeScope)).toEqual({
      kind: "switch",
      scope: globexScope,
    });
  });

  it("stays when the scope already shows the project, and waits for unknown projects", () => {
    expect(step(null, at("thread-a1", api), "all")).toEqual({ kind: "stay" });
    expect(step(null, at("thread-x", dotfiles), "all")).toEqual({ kind: "pending" });
  });
});
