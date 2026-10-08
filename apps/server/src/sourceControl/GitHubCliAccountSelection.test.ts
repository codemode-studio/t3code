import { assert, it } from "@effect/vitest";
import { ProjectId, ProviderProfileId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { GitHubCliAccountSelection } from "./GitHubCliAccountSelection.ts";
import * as GitHubCliAccountSelectionLayer from "./GitHubCliAccountSelection.ts";

const at = "2026-09-01T00:00:00.000Z";
const personal = { host: "github.com", login: "personal" };
const work = { host: "github.com", login: "work" };

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [id, root] of [
    ["project-work", "/src/work"],
    ["project-personal", "/src/personal"],
  ] as const) {
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
      )
      VALUES (${id}, ${id}, ${root}, '[]', ${at}, ${at}, NULL)
    `;
  }
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, payload_json
    )
    VALUES (
      'thread-work', 'project-work', 'Work thread', 'codex', 'full-access', 'default',
      ${at}, ${at}, '{"worktreePath":"/worktrees/work-feature"}'
    )
  `;
});

const profile = (name: string, githubCliAccount?: typeof work) => ({
  name,
  instanceIds: [],
  defaultModelSelection: null,
  ...(githubCliAccount ? { githubCliAccount } : {}),
});

it.effect("uses the account of the profile a checkout's project belongs to", () =>
  Effect.gen(function* () {
    yield* seed;
    const selection = yield* GitHubCliAccountSelection;
    assert.deepStrictEqual(yield* selection.forCwd("/src/work"), work);
    assert.deepStrictEqual(yield* selection.forCwd("/worktrees/work-feature"), work);
    // The environment's default profile covers projects that do not pick one.
    assert.deepStrictEqual(yield* selection.forCwd("/src/personal"), personal);
    // Outside any project, the default profile still applies.
    assert.deepStrictEqual(yield* selection.forCwd("/tmp/elsewhere"), personal);
  }).pipe(
    Effect.provide(
      GitHubCliAccountSelectionLayer.layer.pipe(
        Layer.provide(
          ServerSettings.layerTest({
            providerProfileId: ProviderProfileId.make("personal"),
            providerProfiles: {
              [ProviderProfileId.make("work")]: profile("Work", work),
              [ProviderProfileId.make("personal")]: profile("Personal", personal),
            },
            projectSettingsOverrides: {
              [ProjectId.make("project-work")]: {
                providerProfileId: ProviderProfileId.make("work"),
              },
            },
          }),
        ),
        Layer.provideMerge(SqlitePersistenceMemory),
      ),
    ),
  ),
);

it.effect("leaves projects without a profile account on the environment's choice", () =>
  Effect.gen(function* () {
    yield* seed;
    const selection = yield* GitHubCliAccountSelection;
    assert.deepStrictEqual(yield* selection.forCwd("/src/work"), work);
    assert.strictEqual(yield* selection.forCwd("/src/personal"), null);
  }).pipe(
    Effect.provide(
      GitHubCliAccountSelectionLayer.layer.pipe(
        Layer.provide(
          ServerSettings.layerTest({
            providerProfiles: {
              [ProviderProfileId.make("work")]: profile("Work", work),
              [ProviderProfileId.make("personal")]: profile("Personal"),
            },
            projectSettingsOverrides: {
              [ProjectId.make("project-work")]: {
                providerProfileId: ProviderProfileId.make("work"),
              },
              [ProjectId.make("project-personal")]: {
                providerProfileId: ProviderProfileId.make("personal"),
              },
            },
          }),
        ),
        Layer.provideMerge(SqlitePersistenceMemory),
      ),
    ),
  ),
);
