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
2. `git fetch origin upstream`. Require a clean tree on `main` with `main` equal to `origin/main`. Anything else stops the sync.
3. Record the **carry**, the fork's net delta over upstream, before touching anything:

   ```bash
   git log --oneline --no-merges upstream/main..main          # fork commits
   git diff --name-only $(git merge-base upstream/main main) main   # fork-touched files
   ```

   Save the file list to a file outside the worktree. It is the completion check later.

4. Skim what is incoming: `git log --oneline main..upstream/main`. Note any upstream commit that lands the same feature a fork commit adds; it will need a decision in the merge.

## Merge

Run `git merge upstream/main --no-edit`. With no conflicts, skip to Verify.

Resolve each conflict so both the upstream change and the fork change keep working. Read the fork commit that introduced the fork side (`git log -L` or `git blame` on `main`) before editing. Rules for the recurring cases:

- **`pnpm-lock.yaml`**: take upstream's version, then run `vp i` to regenerate the fork's additions.
- **`.repos/`**: take upstream's version. It is vendored reference material, never fork-edited.
- **`apps/server/src/persistence/Migrations.ts` and `Migrations/NNN_*.ts`**: migrations are registered by number in one ordered list. When upstream took a number the fork also used, the fork migration moves to the next free number after all upstream migrations, in both the filename and the registry entry. Never renumber an upstream migration.
- **Same feature on both sides** (an upstream commit implements what a fork commit did): prefer upstream's implementation and drop the fork's, unless the fork version carries behavior upstream lacks. Record every dropped fork change for the report.
- **Generated or formatted output**: resolve the source, then regenerate or run `vp fmt` on the file instead of hand-merging.

Finish with `git add` on each resolved file and `git merge --continue`. A merge going badly is undone with `git merge --abort`; `main` is back at `origin/main`.

## Verify

1. `vp i`. If upstream bumped a dependency that has a vendored copy in `.repos/`, run `vpr sync:repos`.
2. Diff the carry: `git diff --name-only upstream/main main` must contain every file from the saved list. Each missing file is either a deliberate drop from the merge step or a bug to fix now.
3. Typecheck and test the workspaces the carry touches, not the whole repo: `vp run --filter <workspace> typecheck` and `vp test run <files>` for the carry's test files. Fix failures caused by upstream API changes in fork code; that is the normal cost of a sync.
4. Lint the files you edited during conflict resolution.

## Publish

Push with `git push origin main`. Then report: incoming commit count, each conflict and how it was resolved, every dropped fork change, and the verification commands with their results.
