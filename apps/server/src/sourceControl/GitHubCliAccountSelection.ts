import { ProjectId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import * as ServerSettings from "../serverSettings.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { GitHubCliAccountEnvironment, GitHubCliAccountSelection, tokenEnv } from "./GitHubCli.ts";

/**
 * Resolves the `gh` login for a GitHub command from its cwd: the project
 * rooted there, or the project whose thread owns that worktree.
 *
 * Reads the projection tables directly because the snapshot query depends on
 * source control (repository identity), which depends on `GitHubCli`.
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
          FROM projection_threads AS threads
          JOIN projection_projects AS projects
            ON projects.project_id = threads.project_id AND projects.deleted_at IS NULL
          WHERE threads.worktree_path = ${cwd} AND threads.deleted_at IS NULL
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
        // Nobody picked an account anywhere: skip the project lookup entirely.
        if (
          settings.githubCliAccount === null &&
          !Object.values(settings.projectSettingsOverrides).some(
            (overrides) => overrides.githubCliAccount !== undefined,
          )
        ) {
          return null;
        }
        const projectId = yield* Cache.get(projectIds, cwd);
        return resolveProjectSettings(settings, projectId).settings.githubCliAccount;
      }, Effect.orDie),
    };
  }),
);

/**
 * Hands terminals and agent sessions the selected login's token, so `gh` in them
 * matches the checkout's selection instead of the CLI's globally active login.
 * An unreadable login leaves the environment untouched rather than blocking the process.
 */
export const environmentLayer = Layer.effect(
  GitHubCliAccountEnvironment,
  Effect.gen(function* () {
    const selection = yield* GitHubCliAccountSelection;
    const process = yield* VcsProcess.VcsProcess;
    const environments = yield* Cache.makeWith(
      (key: string) => {
        const [host = "", login = ""] = key.split("\0");
        return process
          .run({
            operation: "GitHubCliAccountEnvironment.token",
            command: "gh",
            args: ["auth", "token", "--hostname", host, "--user", login],
            cwd: globalThis.process.cwd(),
            timeoutMs: 10_000,
            // Blank env tokens so an ambient GH_TOKEN cannot answer for the login.
            env: { ...tokenEnv(host, ""), GH_DEBUG: "" },
          })
          .pipe(
            Effect.map((result) => result.stdout.trim()),
            Effect.flatMap((token) =>
              token ? Effect.succeed(tokenEnv(host, token)) : Effect.fail(null),
            ),
          );
      },
      {
        capacity: 16,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.minutes(1) : Duration.zero),
      },
    );
    return {
      forCwd: Effect.fn("GitHubCliAccountEnvironment.forCwd")(function* (cwd: string) {
        const account = yield* selection.forCwd(cwd);
        if (account === null) return {};
        const host = account.host.toLowerCase();
        return yield* Cache.get(environments, `${host}\0${account.login}`).pipe(
          // Never attach credential lookup output to the log.
          Effect.catch(() =>
            Effect.logWarning(
              "Selected GitHub CLI account is unavailable; using gh's active login.",
              {
                host,
                login: account.login,
              },
            ).pipe(Effect.as({})),
          ),
        );
      }),
    };
  }),
);
