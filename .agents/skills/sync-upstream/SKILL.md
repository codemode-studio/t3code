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

## Hard blocks

- Never push directly to `main`, including `git push origin HEAD:main`, a push
  from local `main`, force pushes, or an API update of the branch ref. Publish
  the sync branch through a pull request. Passing checks or permission to sync
  does not waive this block. Never bypass branch protection.
- Only one unfinished upstream sync may own this repository at a time, across
  all worktrees. Before fetching, resetting, merging, or starting checks, list
  the project's threads with `t3_thread_list` and inspect likely sync threads
  with `t3_thread_read`. Exclude the current thread. Check the task and latest
  messages, not just its title or whether an agent is currently running.
  Another unfinished sync blocks this run even if it is idle, stuck, paused,
  waiting for input or approval, or has a pending sync PR. A completed sync
  does not block a new one.
- If another unfinished sync exists, skip this invocation without changing
  branches, files, or remotes. Report and link the owning thread and its known
  blocker. Do not launch another sync, take it over, cancel it, or declare it
  stale based on elapsed time. Resume that thread when the developer requests
  it. If thread inspection is unavailable or ownership is uncertain, stop
  rather than assume no sync is active.

## Prepare

1. Add the remote if missing: `git remote add upstream git@github.com:pingdotgg/t3code.git`.
2. `git fetch --multiple origin upstream` (plain `git fetch origin upstream` reads `upstream` as a ref on `origin` and fails).
3. Pick where the merge happens. It always starts from `origin/main` with a clean tree; a dirty tree stops the sync.
   - **On `main`** (`git branch --show-current` prints `main`): require `main` equal to `origin/main`, then create a dedicated sync branch before merging. Never merge the sync on local `main`.
   - **Anywhere else**, usually a linked worktree (`git rev-parse --git-dir` differs from `git rev-parse --git-common-dir`) where `main` is checked out in another checkout: leave that checkout alone. Git will not check out `main` twice, and the other checkout may be in use. Merge on the current branch instead, after `git reset --hard origin/main` when it has no commits of its own (`git log origin/main..HEAD` is empty); otherwise stop and ask.

   Check for an existing open sync PR before preparing a branch. An unfinished sync owned by another thread blocks this run; continue the current thread's existing PR instead of creating a duplicate.

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

Publish only after the verification gate above passes or the developer explicitly
accepts the named gaps. Recheck thread ownership, fetch `origin`, and stop if
`origin/main` moved since the merge started. Do not reset or overwrite another
sync's work.

Push only the dedicated sync branch, with an explicit destination such as
`git push -u origin HEAD:refs/heads/<sync-branch>`. Open or update its PR against
`codemode-studio/t3code`'s `main`, following the `file-pr` skill. Register the PR
with the thread when `link_pull_request` is available. Inspect CI for the exact
PR head SHA and report pending checks as pending.

Do not merge the PR unless the developer explicitly asks. When authorized,
require checks and reviews to pass on the latest head, then use GitHub's merge
commit method. Never squash or rebase an upstream sync PR: that would discard
upstream ancestry and cause later syncs to replay the same changes. If the repo
disallows merge commits, stop and report the conflict instead of pushing to
`main` or choosing another merge method.

Report the PR and merge status, incoming commit count, each conflict and its
resolution, every dropped fork change, and verification results with any
explicitly accepted gaps. Leave the main checkout alone; after the PR merges,
say that its local `main` may need a fast-forward.
