---
name: sync-upstream
description: Merge pingdotgg/t3code main into this fork's main, keeping every fork commit and resolving conflicts in favor of both intents.
---

# Sync fork with upstream

This repository is a fork. `origin` is the fork (codemode-studio/t3code) and
`upstream` is pingdotgg/t3code. The fork carries its own features on `main`
as ordinary commits. Syncing means merging upstream into `main` so those
commits survive untouched. Fork PRs land squash-merged as single commits;
each upstream sync is one two-parent merge commit on top of them. Merge, never
rebase: `main` is shared, and a rebase would rewrite every squash commit.

## Prepare

1. Add the remote if missing: `git remote add upstream git@github.com:pingdotgg/t3code.git`.
2. `git fetch --multiple origin upstream` (plain `git fetch origin upstream` reads `upstream` as a ref on `origin` and fails).
3. Pick where the merge happens. It always starts from `origin/main` with a clean tree; a dirty tree stops the sync.
   - **On `main`** (`git branch --show-current` prints `main`): require `main` equal to `origin/main`.
   - **Anywhere else**, usually a linked worktree (`git rev-parse --git-dir` differs from `git rev-parse --git-common-dir`) where `main` is checked out in another checkout: leave that checkout alone. Git will not check out `main` twice, and the other checkout may be in use. Merge on the current branch instead, after `git reset --hard origin/main` when it has no commits of its own (`git log origin/main..HEAD` is empty); otherwise stop and ask.

   The steps below say `origin/main`, never local `main`, because local `main` can lag behind in either mode.

4. Record the **carry**, the fork's net delta over upstream, before touching anything:

   ```bash
   git log --oneline --no-merges upstream/main..origin/main          # fork commits
   git diff --name-only $(git merge-base upstream/main origin/main) origin/main   # fork-touched files
   ```

   Save the file list to a file outside the worktree. It is the completion check later.

5. Skim what is incoming: `git log --oneline origin/main..upstream/main`. Note any upstream commit that lands the same feature a fork commit adds; it will need a decision in the merge.
6. Check the latest CI run for the exact `origin/main` SHA, including failed-job logs, before merging. Record existing failures so they cannot be mistaken for new regressions or silently carried forward. If the latest run is still running, its result is unknown, not green. Use the repository's configured GitHub identity, for example `gh run list --repo codemode-studio/t3code --branch main --workflow CI` and `gh run view <run-id> --repo codemode-studio/t3code --log-failed`.

## Merge

Run `git merge upstream/main -m "Merge upstream/main into main"`. The explicit message keeps the history reading the same whichever branch the merge ran on. With no conflicts, skip to Verify.

Resolve each conflict so both the upstream change and the fork change keep working. Read the fork commit that introduced the fork side (`git log -L` or `git blame` on `origin/main`) before editing. Rules for the recurring cases:

- **`pnpm-lock.yaml`**: take upstream's version, then run `vp i` to regenerate the fork's additions.
- **`.repos/`**: take upstream's version. It is vendored reference material, never fork-edited.
- **`apps/server/src/persistence/Migrations.ts` and `Migrations/NNN_*.ts`**: this list belongs to upstream. Take upstream's numbers and entries untouched, and never add or renumber a fork migration there: the Effect migrator only runs ids above the highest one a database has recorded, so a fork id in that ledger hides upstream migrations from deployed databases, and renumbering the source cannot repair rows already recorded. Fork-owned schema goes in the separate `t3_fork_migrations` ledger in `apps/server/src/persistence/forkMigrations.ts`. Databases written by older fork builds that shared the upstream ledger are repaired there, before upstream migrations run, by reconciling only the exact known fork id and name pairs; never match by number or name alone.
- **Same feature on both sides** (an upstream commit implements what a fork commit did): prefer upstream's implementation and drop the fork's, unless the fork version carries behavior upstream lacks. Record every dropped fork change for the report.
- **Generated or formatted output**: resolve the source, then regenerate or run `vp fmt` on the file instead of hand-merging.

Finish with `git add` on each resolved file and `git merge --continue`. A merge going badly is undone with `git merge --abort`; the branch is back at `origin/main`.

## Verify

1. Match CI's toolchain before installing or checking: read `package.json`, `.github/workflows/ci.yml`, and its setup actions from the merged tree. Confirm the Node version actually used by `vp`, not just the shell's `node`. Use an already-installed compatible runtime through `vp env exec --node <version> ...` when needed; do not change machine defaults. Run `vp i`. If upstream bumped a dependency that has a vendored copy in `.repos/`, run `vpr sync:repos`.
2. Diff the carry: `git diff --name-only upstream/main HEAD` must contain every file from the saved list. Each missing file is either a deliberate drop from the merge step or a bug to fix now.
3. Use focused checks to fix failures quickly, then run the checks that CI runs on a **push to main**. This skill overrides the usual no-repo-wide-checks default for that verification. Read the current workflow rather than relying on a fixed command list: cover Lint, Build and Typecheck, Test, Test Web, every server shard, Rust, and Release Smoke, plus native checks when affected. Include standalone script tests, generated-output checks, and build-output validation from those jobs. Reuse suitable local prerequisites; do not install system packages or copy CI's machine-setup commands onto the developer's computer.
4. Run complete workspace test scripts through `vp run --filter <workspace> test`, using CI's filters and concurrency. For server shards, run all shard indices or the complete unsharded server suite. Do not select tests only from the carry or incoming diff. Upstream tests can exercise fork behavior without either their filenames or the behavior's source files changing. React Compiler coverage tests, for example, inspect fork components across a workspace. Running root Vitest over a mixed list also loses workspace setup and browser projects; use each workspace's script. Run Node/Python script tests with their declared runners.
5. Match behavior-relevant CI environment settings as well as commands. GitHub supplies `GITHUB_REPOSITORY=codemode-studio/t3code` automatically; set it for local CI verification, along with `CI=true` and the job's explicit non-secret settings. Read config fallbacks for release/update sources and build-time defines. Do not unset the fork repository or force upstream defaults just to make assertions pass. For example, these unit tests passed locally without that variable but failed on main because they expected upstream release URLs:

   ```bash
   # Run from apps/web, with the CI-compatible Node runtime selected.
   CI=true GITHUB_REPOSITORY=codemode-studio/t3code vp test run --project unit src/components/desktopUpdate.toast.test.tsx src/components/sidebar/SidebarUpdateReleaseNotes.test.tsx
   ```

6. Fix sync regressions and rerun the failed check, then complete the remaining CI checks. Existing main failures also block publication until fixed or explicitly accepted by the developer. Classify infrastructure failures using logs; do not assume a failing browser assertion is a flake. Browser tests require the repository's explicit permission. If permission is declined, or a required runtime/platform is unavailable, report the exact missing coverage and stop before publishing unless the developer explicitly accepts publishing with that gap. Skipping tests is not permission to push an incompletely verified merge.

## Publish

Push only after the verification gate above passes or the developer explicitly accepts the named gaps. Use `git push origin HEAD:main`; it must fast-forward, so re-fetch and stop if `origin/main` moved. When the merge ran off `main`, the other checkout's local `main` is now behind; say so and leave pulling it to the developer. Inspect CI for the pushed SHA before reporting its status; if pending, say pending rather than claiming CI passed. Then report: incoming commit count, each conflict and how it was resolved, every dropped fork change, and the verification commands with their results, including any explicitly accepted gaps.
