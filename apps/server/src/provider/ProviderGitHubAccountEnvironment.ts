import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { ClaudeAgentSdkQueryRunner } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { GitHubCliAccountEnvironment } from "../sourceControl/GitHubCli.ts";
import { OpenCodeRuntime } from "./opencodeRuntime.ts";

/**
 * Drivers pipe their orchestration adapter's creation through these, so agent
 * sessions start as the checkout's selected `gh` login instead of the CLI's
 * globally active one. Each wraps the process seam the adapter takes from
 * context and keys the login by the cwd the agent process starts in, which is
 * the session's checkout.
 *
 * The selection is read when the driver instance is created: sessions open on
 * orchestrator fibers that do not carry it.
 *
 * Codex and OpenCode 2 share one agent server across every thread of an
 * instance and Cursor runs its agent inside the server process, so none of
 * them can take a per-checkout login. Codex text generation still does: each
 * request spawns its own `codex exec` in the request's checkout.
 */
type GitHubAccounts = (typeof GitHubCliAccountEnvironment)["Service"];

const accountEnvironment = (accounts: GitHubAccounts, cwd: string | null | undefined) =>
  cwd ? accounts.forCwd(cwd) : Effect.succeed({});

const hasEntries = (environment: Readonly<Record<string, string>>) =>
  Object.keys(environment).length > 0;

const withCommandAccount = (
  accounts: GitHubAccounts,
  command: ChildProcess.Command,
): Effect.Effect<ChildProcess.Command> => {
  if (command._tag === "PipedCommand") {
    return Effect.all([
      withCommandAccount(accounts, command.left),
      withCommandAccount(accounts, command.right),
    ]).pipe(Effect.map(([left, right]) => ChildProcess.pipeTo(left, right, command.options)));
  }
  return accountEnvironment(accounts, command.options.cwd).pipe(
    Effect.map((environment) =>
      !hasEntries(environment)
        ? command
        : ChildProcess.make(command.command, command.args, {
            ...command.options,
            // Without an explicit env the child inherits the server's, so keep that.
            ...(command.options.env === undefined
              ? { env: environment, extendEnv: true }
              : { env: { ...command.options.env, ...environment } }),
          }),
    ),
  );
};

/** ACP agents (Grok, Pi, ACP Registry) spawn their process in the session cwd. */
export const withGitHubAccountSpawner = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const accounts = yield* GitHubCliAccountEnvironment;
    return yield* effect.pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) =>
          Effect.flatMap(withCommandAccount(accounts, command), (next) => spawner.spawn(next)),
        ),
      ),
    );
  });

/** Claude starts one CLI process per query. */
export const withGitHubAccountClaudeQueries = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const runner = yield* ClaudeAgentSdkQueryRunner;
    const accounts = yield* GitHubCliAccountEnvironment;
    return yield* effect.pipe(
      Effect.provideService(ClaudeAgentSdkQueryRunner, {
        ...runner,
        open: (input) =>
          accountEnvironment(accounts, input.options.cwd).pipe(
            Effect.flatMap((environment) =>
              runner.open(
                hasEntries(environment)
                  ? {
                      ...input,
                      options: {
                        ...input.options,
                        env: { ...(input.options.env ?? process.env), ...environment },
                      },
                    }
                  : input,
              ),
            ),
          ),
      }),
    );
  });

/**
 * OpenCode 1 spawns a server per session. A configured `serverUrl` keeps that
 * server's own environment and login.
 */
export const withGitHubAccountOpenCodeServers = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const runtime = yield* OpenCodeRuntime;
    const accounts = yield* GitHubCliAccountEnvironment;
    return yield* effect.pipe(
      Effect.provideService(OpenCodeRuntime, {
        ...runtime,
        connectToOpenCodeServer: (input) =>
          accountEnvironment(accounts, input.serverUrl?.trim() ? null : input.directory).pipe(
            Effect.flatMap((environment) =>
              runtime.connectToOpenCodeServer(
                hasEntries(environment)
                  ? {
                      ...input,
                      environment: { ...(input.environment ?? process.env), ...environment },
                    }
                  : input,
              ),
            ),
          ),
      }),
    );
  });
