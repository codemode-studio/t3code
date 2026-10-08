import { ProjectId, type GitHubCliAccount } from "@t3tools/contracts";
import { resolveProjectSettings, resolveProviderProfile } from "@t3tools/shared/projectSettings";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import * as ServerSettings from "../serverSettings.ts";

/**
 * The `gh` login picked by the profile of the project a checkout belongs to, or null to use the
 * environment's choice for the host (Settings → Source Control).
 *
 * A reference, so upstream code paths without project settings (the CLI, most tests) need not
 * provide it. Server layers that read GitHub for a checkout must provide `layer`, or they
 * silently ignore profile accounts.
 */
export class GitHubCliAccountSelection extends Context.Reference<{
  readonly forCwd: (cwd: string) => Effect.Effect<GitHubCliAccount | null>;
}>("t3/sourceControl/GitHubCliAccountSelection", {
  defaultValue: () => ({ forCwd: () => Effect.succeed(null) }),
}) {}

/**
 * Resolves a checkout's project from its cwd: the project rooted there, or the project whose
 * thread owns that worktree.
 *
 * Reads the projection tables directly because the snapshot query depends on
 * source control (repository identity), which depends on this selection.
 */
export const layer = Layer.effect(
  GitHubCliAccountSelection,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const sql = yield* SqlClient.SqlClient;
    const findProjectId = SqlSchema.findOneOption({
      Request: Schema.Struct({ cwd: Schema.String }),
      Result: Schema.Struct({ projectId: ProjectId }),
      execute: ({ cwd }) => sql`
        SELECT project_id AS "projectId" FROM (
          SELECT project_id, 0 AS rank
          FROM projection_projects
          WHERE workspace_root = ${cwd} AND deleted_at IS NULL
          UNION ALL
          SELECT threads.project_id, 1 AS rank
          FROM orchestration_v2_projection_threads AS threads
          JOIN projection_projects AS projects
            ON projects.project_id = threads.project_id AND projects.deleted_at IS NULL
          WHERE json_extract(threads.payload_json, '$.worktreePath') = ${cwd}
            AND threads.deleted_at IS NULL
        )
        ORDER BY rank
        LIMIT 1
      `,
    });
    // A checkout rarely changes project; the TTL still picks up one added or removed there.
    const projectIds = yield* Cache.makeWith(
      (cwd: string) =>
        findProjectId({ cwd }).pipe(
          Effect.map((row) => Option.getOrNull(Option.map(row, ({ projectId }) => projectId))),
        ),
      {
        capacity: 256,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.minutes(1) : Duration.zero),
      },
    );
    return {
      forCwd: Effect.fn("GitHubCliAccountSelection.forCwd")(function* (cwd: string) {
        const settings = yield* serverSettings.getSettings;
        // No profile picks an account: skip the project lookup entirely.
        if (
          !Object.values(settings.providerProfiles).some(
            (profile) => profile.githubCliAccount !== undefined,
          )
        ) {
          return null;
        }
        const projectId = yield* Cache.get(projectIds, cwd);
        const resolved = resolveProjectSettings(settings, projectId).settings;
        return resolveProviderProfile(resolved)?.githubCliAccount ?? null;
      }, Effect.orDie),
    };
  }),
);
