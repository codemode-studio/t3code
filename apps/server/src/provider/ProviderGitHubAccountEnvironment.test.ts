import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { ClaudeAgentSdkQueryRunner } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { GitHubCliAccountEnvironment } from "../sourceControl/GitHubCli.ts";
import { OpenCodeRuntime } from "./opencodeRuntime.ts";
import {
  withGitHubAccountClaudeQueries,
  withGitHubAccountOpenCodeServers,
  withGitHubAccountSpawner,
} from "./ProviderGitHubAccountEnvironment.ts";

const checkout = "/work/selected";
const selected = { GH_TOKEN: "selected", GITHUB_TOKEN: "selected" };
const accounts = Effect.provideService(GitHubCliAccountEnvironment, {
  forCwd: (cwd) => Effect.succeed(cwd === checkout ? selected : {}),
});
const recorded = <A>(values: Array<A>, value: A) =>
  Effect.sync(() => values.push(value)).pipe(Effect.andThen(Effect.die("recorded")));

describe("ProviderGitHubAccountEnvironment", () => {
  it.effect("spawns agent processes as their checkout's selected login", () =>
    Effect.gen(function* () {
      const commands: Array<ChildProcess.Command> = [];
      const spawnAll = Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        for (const command of [
          ChildProcess.make("grok", [], { cwd: checkout, env: { PATH: "/bin" } }),
          ChildProcess.make("pi", [], { cwd: checkout }),
          ChildProcess.make("grok", [], { cwd: "/work/other", env: { PATH: "/bin" } }),
        ]) {
          yield* spawner.spawn(command).pipe(Effect.scoped, Effect.exit);
        }
      });
      yield* withGitHubAccountSpawner(spawnAll).pipe(
        accounts,
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => recorded(commands, command)),
        ),
      );
      expect(
        commands.map((command) =>
          command._tag === "StandardCommand"
            ? { env: command.options.env, extendEnv: command.options.extendEnv }
            : null,
        ),
      ).toEqual([
        { env: { PATH: "/bin", ...selected }, extendEnv: undefined },
        // A command that inherited the server's environment keeps inheriting it.
        { env: selected, extendEnv: true },
        { env: { PATH: "/bin" }, extendEnv: undefined },
      ]);
    }),
  );

  it.effect("starts Claude queries as the session checkout's selected login", () =>
    Effect.gen(function* () {
      const environments: Array<unknown> = [];
      yield* withGitHubAccountClaudeQueries(
        Effect.gen(function* () {
          const runner = yield* ClaudeAgentSdkQueryRunner;
          yield* runner
            .open({
              threadId: ThreadId.make("thread-claude"),
              providerSessionId: ProviderSessionId.make("session-claude"),
              options: {
                model: "claude",
                tools: [],
                permissionMode: "default",
                sessionId: "native-session-claude",
                cwd: checkout,
                env: { HOME: "/home" },
              },
            })
            .pipe(Effect.exit);
        }),
      ).pipe(
        accounts,
        Effect.provide(
          Layer.mock(ClaudeAgentSdkQueryRunner)({
            open: (input) => recorded(environments, input.options.env),
          }),
        ),
      );
      expect(environments).toEqual([{ HOME: "/home", ...selected }]);
    }),
  );

  it.effect("leaves an external OpenCode server's login alone", () =>
    Effect.gen(function* () {
      const environments: Array<NodeJS.ProcessEnv | undefined> = [];
      yield* withGitHubAccountOpenCodeServers(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          for (const serverUrl of [null, "http://127.0.0.1:4096"]) {
            yield* runtime
              .connectToOpenCodeServer({
                binaryPath: "opencode",
                directory: checkout,
                serverUrl,
                environment: { PATH: "/bin" },
              })
              .pipe(Effect.scoped, Effect.exit);
          }
        }),
      ).pipe(
        accounts,
        Effect.provide(
          Layer.mock(OpenCodeRuntime)({
            connectToOpenCodeServer: (input) => recorded(environments, input.environment),
            createOpenCodeSdkClient: () => expect.unreachable("no client is created"),
          }),
        ),
      );
      expect(environments).toEqual([{ PATH: "/bin", ...selected }, { PATH: "/bin" }]);
    }),
  );
});
