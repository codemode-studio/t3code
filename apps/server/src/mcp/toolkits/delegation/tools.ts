import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as DelegationService from "../../../delegation/DelegationService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const DelegateTaskInput = Schema.Struct({
  threadId: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Continue a task you delegated earlier, for example to ask for a re-review after fixing its findings. Use the threadId from its result message or from starting it. That agent keeps its conversation, so the prompt only needs what changed. Leave out to start a new task.",
    }),
  ),
  provider: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        'Which provider runs a new task: an instance id or provider name such as "codex", "claudeAgent", "cursor" or "opencode". An unknown name fails with the list of available providers. Required unless threadId is set; ignored with it.',
    }),
  ),
  prompt: TrimmedNonEmptyString.annotate({
    description:
      "The task for the other agent. A new task starts with no knowledge of this conversation, so include everything it needs, such as what to review and what to report back.",
  }),
  title: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        'A short name for a new task, for example "Review current changes". Ignored with threadId.',
    }),
  ),
  model: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Model slug for a new task. Defaults to the provider's default model. Ignored with threadId.",
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
    "Hand a task to another coding agent, for example asking Codex to review the current work. It runs as its own T3 Code thread in this same working copy, shows in this thread's Agents panel, and returns immediately. When it finishes, its final message arrives in this thread as a new message, so do not poll or wait for it: tell the user what you delegated, then continue other work or end your turn. Avoid editing the same files while it runs. To follow up on a finished task, such as a re-review, pass its threadId instead of starting a new task.",
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
