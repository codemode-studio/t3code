import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const FileSkill = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  path: TrimmedNonEmptyString,
  source: Schema.String,
  scope: Schema.Literals(["personal", "project"]),
});
export type FileSkill = typeof FileSkill.Type;

export const SkillsListInput = Schema.Struct({
  workspaceRoots: Schema.Array(TrimmedNonEmptyString),
});
export type SkillsListInput = typeof SkillsListInput.Type;

export const SkillsListResult = Schema.Struct({
  skills: Schema.Array(FileSkill),
  errors: Schema.Array(Schema.String),
});
export type SkillsListResult = typeof SkillsListResult.Type;

export const SkillsCreateInput = Schema.Struct({
  cwd: Schema.optional(TrimmedNonEmptyString),
  name: TrimmedNonEmptyString.check(
    Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    Schema.isMaxLength(64),
  ),
  description: Schema.String.check(Schema.isMaxLength(4096)),
  instructions: TrimmedNonEmptyString.check(Schema.isMaxLength(100_000)),
});
export type SkillsCreateInput = typeof SkillsCreateInput.Type;

export class SkillsError extends Schema.TaggedError<SkillsError>()("SkillsError", {
  message: Schema.String,
}) {}
