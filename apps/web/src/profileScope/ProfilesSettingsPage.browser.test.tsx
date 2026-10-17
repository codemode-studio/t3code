import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { searchableSetting } from "../components/settings/settingsSearch";
import { ProfilesSettingsPage } from "./ProfilesSettingsPage";

const harness = vi.hoisted(() => ({
  scope: {} as Record<string, unknown>,
  lifecycle: [] as string[],
}));

vi.mock("../components/settings/SettingsScopeContext", () => ({
  useSettingsScope: () => harness.scope,
}));
vi.mock("../components/settings/settingsLayout", async () => {
  const { createElement: h } = await import("react");
  type Children = { readonly children?: import("react").ReactNode };
  return {
    SettingsPageContainer: ({ children }: Children) => h("main", null, children),
    SettingsSearchTarget: ({ children, ...props }: Children & Record<string, unknown>) =>
      h("div", props, children),
  };
});
vi.mock("../environments/primary", () => ({
  usePrimarySessionState: () => ({ data: null, isPending: false, error: null }),
}));
vi.mock("../state/session", () => ({
  useEnvironmentSessionState: () => ({ data: null, isPending: false, hasError: false }),
}));
// Stands in for the cards and editor: holds an in-progress draft for the environment it mounted
// with, like the editor dialog's state.
vi.mock("./EnvironmentProfiles", async () => {
  const { createElement: h, useEffect, useState } = await import("react");
  return {
    EnvironmentProfiles: ({ environmentId }: { environmentId: string }) => {
      const [draft] = useState(() => `draft for ${environmentId}`);
      useEffect(() => {
        harness.lifecycle.push(`mount ${environmentId}`);
        return () => {
          harness.lifecycle.push(`unmount ${environmentId}`);
        };
      }, [environmentId]);
      return h("section", { "data-draft": draft });
    },
  };
});

function remote(environmentId: string) {
  return { environmentId, entry: { target: { _tag: "RemoteConnectionTarget" } } };
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("ProfilesSettingsPage", () => {
  const anchorId = searchableSetting("provider-profiles").id;
  const anchors = () => container.querySelectorAll(`#${anchorId}`);

  it("starts fresh when the representative environment changes, so drafts never cross over", async () => {
    harness.lifecycle.length = 0;
    // "All environments": A represents the selection until it disconnects and B takes over.
    harness.scope = { environment: remote("env-a"), scope: { kind: "all" } };
    await act(() => {
      root.render(createElement(ProfilesSettingsPage));
    });
    harness.scope = { environment: remote("env-b"), scope: { kind: "all" } };
    await act(() => root.render(createElement(ProfilesSettingsPage)));

    expect(harness.lifecycle).toEqual(["mount env-a", "unmount env-a", "mount env-b"]);
    expect(container.querySelector("section")?.getAttribute("data-draft")).toBe("draft for env-b");
  });

  it("keeps the search anchor with and without an environment", async () => {
    harness.scope = { environment: null, scope: { kind: "all" } };
    await act(() => {
      root.render(createElement(ProfilesSettingsPage));
    });
    expect(anchors()).toHaveLength(1);
    harness.scope = { environment: remote("env-a"), scope: { kind: "all" } };
    await act(() => root.render(createElement(ProfilesSettingsPage)));
    expect(anchors()).toHaveLength(1);
  });
});
