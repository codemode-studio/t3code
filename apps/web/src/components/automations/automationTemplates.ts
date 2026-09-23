import type { AutomationTrigger } from "@t3tools/contracts";
import {
  BookOpenIcon,
  BugIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  FileSearchIcon,
  InboxIcon,
  KeyRoundIcon,
  type LucideIcon,
  NewspaperIcon,
  PackageIcon,
  ScissorsIcon,
  ShieldCheckIcon,
} from "lucide-react";

import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";

export const AUTOMATION_TEMPLATE_CATEGORIES = [
  "Popular",
  "Code Review",
  "Security",
  "Incidents & Triage",
  "Research",
  "Maintenance",
] as const;
export type AutomationTemplateCategory = (typeof AUTOMATION_TEMPLATE_CATEGORIES)[number];

export interface AutomationTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon: LucideIcon;
  readonly categories: readonly AutomationTemplateCategory[];
  readonly trigger: AutomationTrigger;
  readonly prompt: string;
}

function schedule(
  cadence: "hourly" | "daily" | "weekdays" | "weekly",
  hour: number,
  minute = 0,
  weekday = 1,
): AutomationTrigger {
  return { type: "schedule", cadence, hour, minute, weekday };
}

export const AUTOMATION_TEMPLATES: readonly AutomationTemplate[] = [
  {
    id: "find-critical-bugs",
    name: "Find critical bugs",
    description: "Analyze recent commits for high-severity correctness bugs and submit safe fixes",
    icon: CircleAlertIcon,
    categories: ["Popular", "Code Review"],
    trigger: schedule("weekdays", 9),
    prompt: `Review the commits merged in the last day for high-severity correctness bugs.

- Focus on logic errors, data loss, crashes, and broken edge cases, not style
- Verify each suspected bug by reading the surrounding code or reproducing it
- Fix only bugs you have confirmed, with the smallest safe change and a test
- Summarize what you checked, what you fixed, and anything that needs a human`,
  },
  {
    id: "scan-vulnerabilities",
    name: "Scan codebase for vulnerabilities",
    description:
      "Review the full repository on a schedule and alert on validated high-impact security issues",
    icon: FileSearchIcon,
    categories: ["Popular", "Security"],
    trigger: schedule("weekly", 10, 0, 1),
    prompt: `Audit this repository for high-impact security issues.

- Look for injection, auth bypass, path traversal, unsafe deserialization, and secrets handling
- Validate each finding by tracing how untrusted input reaches it
- Report only validated issues, ranked by impact, with file paths and a suggested fix
- Do not change code unless a fix is small and clearly safe`,
  },
  {
    id: "generate-docs",
    name: "Generate docs",
    description:
      "Create and update developer documentation for recently changed or under-documented code",
    icon: BookOpenIcon,
    categories: ["Popular", "Maintenance"],
    trigger: schedule("weekly", 9, 0, 1),
    prompt: `Find code changed in the last week that lacks or contradicts its documentation.

- Update existing docs that are now inaccurate before writing anything new
- Add concise docs for public APIs and non-obvious behavior
- Match the repository's existing documentation style and location
- List the files you touched and why`,
  },
  {
    id: "add-test-coverage",
    name: "Add test coverage",
    description:
      "Review recent changes and add tests for high-risk logic that lacks adequate coverage",
    icon: CircleCheckIcon,
    categories: ["Popular", "Code Review"],
    trigger: schedule("weekdays", 11),
    prompt: `Look at the changes merged in the last day and find high-risk logic without tests.

- Prioritize branching logic, parsing, money, permissions, and data migrations
- Write focused tests that assert observable behavior, following existing test patterns
- Run the tests you add and make sure they pass
- Summarize the coverage you added`,
  },
  {
    id: "review-pull-requests",
    name: "Review new pull requests",
    description:
      "When a pull request is opened, review it for bugs, risky changes, and missing tests",
    icon: PullRequestGlyph.pullRequest,
    categories: ["Code Review"],
    trigger: { type: "github", event: "pull_request.opened" },
    prompt: `A pull request was opened. Review it.

- Check out the pull request branch and read the full diff
- Look for correctness bugs, risky changes, and missing tests
- Verify each concern against the code before reporting it
- Summarize the review with concrete, actionable comments`,
  },
  {
    id: "review-drafts",
    name: "Early feedback on drafts",
    description: "When a draft pull request is opened, give early feedback on the approach",
    icon: PullRequestGlyph.pullRequest,
    categories: ["Code Review"],
    trigger: { type: "github", event: "pull_request.draft_opened" },
    prompt: `A draft pull request was opened. Give early feedback on the approach.

- Read the diff and the pull request description
- Point out design problems and simpler alternatives before the details
- Keep it short: the author is still working`,
  },
  {
    id: "audit-dependencies",
    name: "Audit dependencies",
    description: "Check dependencies for known vulnerabilities and risky or abandoned packages",
    icon: PackageIcon,
    categories: ["Security", "Maintenance"],
    trigger: schedule("weekly", 10, 0, 3),
    prompt: `Audit this project's dependencies.

- Run the package manager's audit command if one exists
- Flag known vulnerabilities, abandoned packages, and unexpected new transitive dependencies
- Propose upgrades for real issues, noting any breaking changes
- Do not upgrade anything with a breaking change without explaining the migration`,
  },
  {
    id: "check-secrets",
    name: "Check for leaked secrets",
    description:
      "Scan recent commits for credentials, tokens, and keys that should not be committed",
    icon: KeyRoundIcon,
    categories: ["Security"],
    trigger: schedule("daily", 8),
    prompt: `Scan the commits from the last day for leaked secrets.

- Look for API keys, tokens, private keys, passwords, and connection strings
- Ignore obvious test fixtures and placeholders
- For each real finding, give the commit, file, and what must be rotated`,
  },
  {
    id: "triage-github-issues",
    name: "Triage GitHub issues",
    description:
      "When a GitHub issue is opened, inspect the repo and add a concrete reproduction or next step",
    icon: InboxIcon,
    categories: ["Incidents & Triage"],
    trigger: { type: "github", event: "issue.opened" },
    prompt: `A new GitHub issue was opened. Triage it against this repo.

- Reproduce or locate the relevant code if the report is specific enough
- Label the severity in your summary (blocker / bug / request / unclear)
- Add a concrete next step: file paths, likely cause, or the missing information
- Do not implement a large fix unless the issue is clearly a small, validated bug`,
  },
  {
    id: "watch-failing-checks",
    name: "Watch failing checks",
    description:
      "On a weekday morning, run the project's tests and diagnose anything that is already red",
    icon: BugIcon,
    categories: ["Incidents & Triage"],
    trigger: schedule("weekdays", 8, 30),
    prompt: `Run this project's test suite and linters.

- If everything passes, say so in one line
- For each failure, find the cause and the commit that introduced it
- Fix failures that are clearly small and safe; explain the rest`,
  },
  {
    id: "daily-changelog",
    name: "Summarize yesterday's changes",
    description: "Write a short digest of what changed in the repository over the last day",
    icon: NewspaperIcon,
    categories: ["Research"],
    trigger: schedule("weekdays", 9),
    prompt: `Summarize what changed in this repository over the last day.

- Group changes by area, most important first
- Call out breaking changes, migrations, and anything that needs follow-up
- Keep it short enough to read in a minute`,
  },
  {
    id: "remove-dead-code",
    name: "Clean up dead code",
    description: "Find unused exports, files, and feature flags, and remove what is safe to remove",
    icon: ScissorsIcon,
    categories: ["Maintenance"],
    trigger: schedule("weekly", 10, 0, 5),
    prompt: `Find dead code in this repository.

- Look for unused exports, unreachable branches, stale feature flags, and orphaned files
- Confirm each item is truly unused, including dynamic and cross-package references
- Remove only what you have confirmed, and run the build and tests afterward`,
  },
  {
    id: "security-review-prs",
    name: "Security review for pull requests",
    description: "When a pull request is opened, check it for security-sensitive changes",
    icon: ShieldCheckIcon,
    categories: ["Security", "Code Review"],
    trigger: { type: "github", event: "pull_request.opened" },
    prompt: `A pull request was opened. Review it for security issues only.

- Focus on auth, input handling, secrets, file system and network access
- Report validated issues with file paths and a suggested fix
- If nothing is security-relevant, say so in one line`,
  },
];
