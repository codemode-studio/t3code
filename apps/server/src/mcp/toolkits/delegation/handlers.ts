import * as Effect from "effect/Effect";

import * as DelegationService from "../../../delegation/DelegationService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { DelegationToolkit } from "./tools.ts";

export const DelegationToolkitHandlersLive = DelegationToolkit.toLayer(
  Effect.succeed(
    DelegationToolkit.of({
      delegate_task: (input) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const delegation = yield* DelegationService.DelegationService;
          return yield* delegation.delegate({ parentThreadId: scope.threadId, ...input });
        }),
    }),
  ),
);
