import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { nestThreadsUnderParents } from "./threadNesting.ts";

const LOCAL = EnvironmentId.make("local");
const REMOTE = EnvironmentId.make("remote");

const thread = (
  id: string,
  options: { parent?: string; createdAt?: string; environmentId?: EnvironmentId } = {},
) => ({
  environmentId: options.environmentId ?? LOCAL,
  id: ThreadId.make(id),
  parentThreadId: options.parent === undefined ? null : ThreadId.make(options.parent),
  createdAt: options.createdAt ?? "2026-10-01T10:00:00.000Z",
});

const childIds = (result: ReturnType<typeof nestThreadsUnderParents>, parentKey: string) =>
  result.childrenByParentKey.get(parentKey)?.map((child) => child.id) ?? [];

describe("nestThreadsUnderParents", () => {
  it("nests children under their parent, oldest first", () => {
    const parent = thread("parent");
    const all = [
      parent,
      thread("later", { parent: "parent", createdAt: "2026-10-01T12:00:00.000Z" }),
      thread("earlier", { parent: "parent", createdAt: "2026-10-01T11:00:00.000Z" }),
      thread("unrelated"),
    ];
    const result = nestThreadsUnderParents([parent], all);
    expect(childIds(result, "local:parent")).toEqual(["earlier", "later"]);
    expect([...result.nestedKeys].toSorted()).toEqual(["local:earlier", "local:later"]);
  });

  it("keeps a child on its own row when its parent cannot host it", () => {
    // The parent is settled or snoozed, or not loaded at all.
    const result = nestThreadsUnderParents(
      [thread("active")],
      [thread("settled-parent"), thread("child", { parent: "settled-parent" })],
    );
    expect(result.nestedKeys.size).toBe(0);
  });

  it("matches parents within the child's own environment", () => {
    const parent = thread("parent", { environmentId: REMOTE });
    const result = nestThreadsUnderParents(
      [parent],
      [parent, thread("child", { parent: "parent" })],
    );
    expect(result.nestedKeys.size).toBe(0);
  });

  it("never hides a grandchild under a nested parent", () => {
    const all = [
      thread("root"),
      thread("child", { parent: "root" }),
      thread("grandchild", { parent: "child" }),
    ];
    const result = nestThreadsUnderParents(all, all);
    expect(childIds(result, "local:root")).toEqual(["child"]);
    expect(result.nestedKeys.has("local:grandchild")).toBe(false);
  });
});
