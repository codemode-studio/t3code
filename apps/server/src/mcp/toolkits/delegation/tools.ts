import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as DelegationService from "../../../delegation/DelegationService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const DelegateTaskInput = Schema.Struct({
  provider: TrimmedNonEmptyString.annotate({
    description:
      'Which provider runs the task: an instance id or provider name such as "codex", "claudeAgent", "cursor" or "opencode". An unknown name fails with the list of available providers.',
  }),
  prompt: TrimmedNonEmptyString.annotate({
    description:
      "The full task for the other agent. It starts with no knowledge of this conversation, so include everything it needs, such as what to review and what to report back.",
  }),
  title: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: 'A short name for the task, for example "Review current changes".',
    }),
  ),
  model: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Model slug to run with. Defaults to the provider's default model.",
    }),
  ),
});

export const DelegateTaskResult = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  provider: Schema.String,
  model: Schema.String,
});

const DelegateTaskTool = Tool.make("delegate_task", {
  description:
    "Hand a task to another coding agent, for example asking Codex to review the current work. It runs as its own T3 Code thread in this same working copy, shows in this thread's Agents panel, and returns immediately. When it finishes, its final message arrives in this thread as a new message, so do not poll or wait for it: tell the user what you delegated, then continue other work or end your turn. Avoid editing the same files while it runs.",
  parameters: DelegateTaskInput,
  success: DelegateTaskResult,
  failure: DelegationService.DelegationError,
  dependencies: [McpInvocationContext.McpInvocationContext, DelegationService.DelegationService],
})
  .annotate(Tool.Title, "Delegate task to another agent")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const DelegationToolkit = Toolkit.make(DelegateTaskTool);
