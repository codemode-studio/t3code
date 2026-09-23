import * as Cron from "effect/Cron";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { DEFAULT_RUNTIME_MODE, ModelSelection, RuntimeMode } from "./orchestration.ts";

export const AutomationScheduleCadence = Schema.Literals(["hourly", "daily", "weekdays", "weekly"]);
export type AutomationScheduleCadence = typeof AutomationScheduleCadence.Type;

/**
 * A recurring time in the environment's local time zone. `hour` is ignored for hourly schedules
 * and `weekday` (0 = Sunday) is only read by weekly ones.
 */
export const AutomationScheduleTrigger = Schema.Struct({
  type: Schema.Literal("schedule"),
  cadence: AutomationScheduleCadence,
  hour: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 23 })),
  minute: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 59 })),
  weekday: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
});
export type AutomationScheduleTrigger = typeof AutomationScheduleTrigger.Type;

/** Standard five-field cron (minute hour day-of-month month day-of-week). */
export function isValidAutomationCronExpression(expression: string): boolean {
  const trimmed = expression.trim();
  return trimmed.split(/\s+/).length === 5 && Result.isSuccess(Cron.parse(trimmed));
}

/** A custom schedule, read in the environment's local time zone like the presets. */
export const AutomationCronTrigger = Schema.Struct({
  type: Schema.Literal("cron"),
  expression: TrimmedNonEmptyString.check(
    Schema.isMaxLength(200),
    Schema.makeFilter(isValidAutomationCronExpression, {
      message: "Expected a five-field cron expression",
    }),
  ),
});
export type AutomationCronTrigger = typeof AutomationCronTrigger.Type;

export const AutomationGitHubEvent = Schema.Literals([
  "pull_request.opened",
  "pull_request.draft_opened",
  "issue.opened",
]);
export type AutomationGitHubEvent = typeof AutomationGitHubEvent.Type;

/** Polled with the environment's `gh` CLI against the project's repository. */
export const AutomationGitHubTrigger = Schema.Struct({
  type: Schema.Literal("github"),
  event: AutomationGitHubEvent,
});
export type AutomationGitHubTrigger = typeof AutomationGitHubTrigger.Type;

export const AutomationTrigger = Schema.Union([
  AutomationScheduleTrigger,
  AutomationCronTrigger,
  AutomationGitHubTrigger,
]);
export type AutomationTrigger = typeof AutomationTrigger.Type;

/** Where a run works: a fresh worktree per run, or the project checkout itself. */
export const AutomationWorkingCopy = Schema.Literals(["worktree", "local"]);
export type AutomationWorkingCopy = typeof AutomationWorkingCopy.Type;

/** Whether each run opens a new thread or sends another turn to the previous run's thread. */
export const AutomationConversation = Schema.Literals(["fresh", "continue"]);
export type AutomationConversation = typeof AutomationConversation.Type;

export const AutomationRun = Schema.Struct({
  id: TrimmedNonEmptyString,
  startedAt: IsoDateTime,
  /** Human-readable cause, e.g. "Weekdays at 09:00" or "Pull request #12 opened". */
  cause: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  error: Schema.NullOr(Schema.String),
});
export type AutomationRun = typeof AutomationRun.Type;

export const AUTOMATION_NAME_MAX_LENGTH = 200;
export const AUTOMATION_PROMPT_MAX_LENGTH = 50_000;
export const AUTOMATION_MAX_TRIGGERS = 20;
export const AUTOMATION_MAX_RUNS = 20;
export const DEFAULT_AUTOMATION_CATCH_UP_MINUTES = 60;

/** Everything a user edits. The server owns ids, timestamps and run history. */
export const AutomationConfig = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(AUTOMATION_NAME_MAX_LENGTH)),
  enabled: Schema.Boolean,
  projectId: ProjectId,
  triggers: Schema.Array(AutomationTrigger).check(Schema.isMaxLength(AUTOMATION_MAX_TRIGGERS)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(AUTOMATION_PROMPT_MAX_LENGTH)),
  modelSelection: Schema.NullOr(ModelSelection),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  workingCopy: AutomationWorkingCopy,
  conversation: AutomationConversation,
  /** How late a missed scheduled run may still start, e.g. after the machine slept. */
  catchUpMinutes: NonNegativeInt,
});
export type AutomationConfig = typeof AutomationConfig.Type;

export const Automation = Schema.Struct({
  ...AutomationConfig.fields,
  id: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Newest first, capped at `AUTOMATION_MAX_RUNS`. */
  runs: Schema.Array(AutomationRun),
});
export type Automation = typeof Automation.Type;

export const AutomationsSnapshot = Schema.Struct({
  automations: Schema.Array(Automation),
});
export type AutomationsSnapshot = typeof AutomationsSnapshot.Type;

export const AutomationCreateInput = Schema.Struct({ config: AutomationConfig });
export type AutomationCreateInput = typeof AutomationCreateInput.Type;

export const AutomationUpdateInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  config: AutomationConfig,
});
export type AutomationUpdateInput = typeof AutomationUpdateInput.Type;

export const AutomationIdInput = Schema.Struct({ id: TrimmedNonEmptyString });
export type AutomationIdInput = typeof AutomationIdInput.Type;

export class AutomationError extends Schema.TaggedError<AutomationError>()("AutomationError", {
  message: Schema.String,
}) {}
