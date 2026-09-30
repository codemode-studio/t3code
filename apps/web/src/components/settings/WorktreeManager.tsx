import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { VcsListedWorktree } from "@t3tools/contracts";
import {
  FolderGit2Icon,
  FolderIcon,
  GitBranchIcon,
  MessageSquareIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useState, type FormEvent } from "react";

import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Input } from "../ui/input";
import {
  Select,
  SelectGroup,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsSection } from "./settingsLayout";
import {
  worktreeThreads,
  worktreeDeletionBlockReason,
  type WorktreeDeletionTarget,
} from "./worktreeManager.logic";

function commandError(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "The operation failed.";
}

function CreateWorktreeDialog({
  cwd,
  environmentId,
  onClose,
  onCreated,
}: {
  cwd: string;
  environmentId: Parameters<typeof vcsEnvironment.listWorktrees>[0]["environmentId"];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [branchMode, setBranchMode] = useState<"new" | "existing">("new");
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("HEAD");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createWorktree = useAtomCommand(vcsEnvironment.createWorktree, { reportFailure: false });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !branch.trim() || (branchMode === "new" && !base.trim())) return;
    setBusy(true);
    setError(null);
    const result = await createWorktree({
      environmentId,
      input: {
        cwd,
        refName: branchMode === "new" ? base.trim() : branch.trim(),
        ...(branchMode === "new" ? { newRefName: branch.trim() } : {}),
        path: null,
      },
    });
    setBusy(false);
    if (result._tag === "Success") onCreated();
    else setError(commandError(result));
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Create worktree</DialogTitle>
          <DialogDescription>Create a separate working copy of this project.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)}>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <label className="flex flex-col gap-1.5 text-sm">
                Branch type
                <Select
                  value={branchMode}
                  onValueChange={(value) => {
                    if (value === "new" || value === "existing") {
                      setBranchMode(value);
                      setBranch("");
                    }
                  }}
                >
                  <SelectTrigger aria-label="Branch type">
                    <SelectValue>
                      {branchMode === "new" ? "Create a new branch" : "Use an existing branch"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectGroup>
                      <SelectItem value="new">Create a new branch</SelectItem>
                      <SelectItem value="existing">Use an existing branch</SelectItem>
                    </SelectGroup>
                  </SelectPopup>
                </Select>
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                {branchMode === "new" ? "New branch name" : "Existing local branch"}
                <Input
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  placeholder="feature/my-task"
                  disabled={busy}
                />
              </label>
              {branchMode === "new" && (
                <label className="flex flex-col gap-1.5 text-sm">
                  Start from
                  <Input
                    autoComplete="off"
                    spellCheck={false}
                    value={base}
                    onChange={(event) => setBase(event.target.value)}
                    disabled={busy}
                  />
                  <span className="text-xs text-muted-foreground">
                    Use HEAD for the current commit, or enter a branch or ref.
                  </span>
                </label>
              )}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || !branch.trim() || (branchMode === "new" && !base.trim())}
            >
              {busy ? "Creating…" : "Create worktree"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function worktreeName(tree: VcsListedWorktree) {
  return tree.path.split(/[\\/]/).at(-1) ?? tree.path;
}

export function WorktreeManager() {
  const { scope, connectedEnvironments } = useSettingsScope();
  const [selectedMemberKey, setSelectedMemberKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [deleting, setDeleting] = useState<ReadonlyArray<WorktreeDeletionTarget> | null>(null);
  // Keep the targets through the close animation.
  const [shownDeleting, setShownDeleting] = useState(deleting);
  if (deleting !== null && deleting !== shownDeleting) setShownDeleting(deleting);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threads = useThreadShells();
  const projects = useProjects();
  const members = scope.kind === "project" || scope.kind === "checkout" ? scope.members : [];
  const connectedMembers = members.filter((member) =>
    connectedEnvironments.some((environment) => environment.environmentId === member.environmentId),
  );
  const member =
    connectedMembers.find((candidate) => candidate.physicalProjectKey === selectedMemberKey) ??
    connectedMembers[0] ??
    null;
  const projectKey =
    scope.kind === "project" || scope.kind === "checkout" ? scope.group.projectKey : null;
  const query = useEnvironmentQuery(
    member === null
      ? null
      : vcsEnvironment.listWorktrees({
          environmentId: member.environmentId,
          input: { cwd: member.workspaceRoot },
        }),
  );
  const removeWorktree = useAtomCommand(vcsEnvironment.removeWorktree, { reportFailure: false });
  const worktrees = query.data?.worktrees.filter((tree) => !tree.isMain) ?? [];
  const threadsByWorktree = member
    ? worktreeThreads(threads, projects, member.environmentId)
    : null;
  const associatedThreads = (tree: VcsListedWorktree) => threadsByWorktree?.get(tree.path) ?? [];
  const rows = member
    ? worktrees.map((tree) => {
        const usedBy = associatedThreads(tree);
        const target = {
          environmentId: member.environmentId,
          cwd: member.workspaceRoot,
          worktree: tree,
        };
        return {
          tree,
          target,
          usedBy,
          blocked: worktreeDeletionBlockReason(target, member, usedBy),
        };
      })
    : [];
  const selectedTargets = rows
    .filter((row) => !row.blocked && selectedPaths.has(row.tree.path))
    .map((row) => row.target);
  const deletingThreadsByWorktree = shownDeleting?.[0]
    ? worktreeThreads(threads, projects, shownDeleting[0].environmentId)
    : null;
  const deletingThreadCount =
    shownDeleting?.reduce(
      (count, target) =>
        count + (deletingThreadsByWorktree?.get(target.worktree.path)?.length ?? 0),
      0,
    ) ?? 0;
  const deletionBlocked = (() => {
    if (!deleting) return null;
    for (const target of deleting) {
      const reason = worktreeDeletionBlockReason(
        target,
        member,
        deletingThreadsByWorktree?.get(target.worktree.path) ?? [],
      );
      if (reason)
        return deleting.length > 1 ? `${worktreeName(target.worktree)}: ${reason}` : reason;
    }
    return null;
  })();
  const deleteWorktrees = async () => {
    if (!deleting || deletionBlocked || busy) return;
    setBusy(true);
    setError(null);
    const failed: Array<{ target: WorktreeDeletionTarget; message: string }> = [];
    const removed = new Set<string>();
    // One at a time: each removal rewrites the repository's shared worktree metadata.
    for (const target of deleting) {
      const result = await removeWorktree({
        environmentId: target.environmentId,
        input: { cwd: target.cwd, path: target.worktree.path, force: true },
      });
      if (result._tag === "Success") removed.add(target.worktree.path);
      else failed.push({ target, message: commandError(result) });
    }
    setBusy(false);
    setSelectedPaths((current) => new Set([...current].filter((path) => !removed.has(path))));
    if (failed.length === 0) {
      setDeleting(null);
      return;
    }
    setDeleting(failed.map((failure) => failure.target));
    setError(
      deleting.length === 1
        ? failed[0]!.message
        : failed
            .map((failure) => `${worktreeName(failure.target.worktree)}: ${failure.message}`)
            .join("\n"),
    );
  };
  const toggleSelected = (path: string, checked: boolean) =>
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (checked) next.add(path);
      else next.delete(path);
      return next;
    });
  return (
    <SettingsSection id="storage-manage-worktrees" title="Manage worktrees">
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {connectedMembers.length > 1 && (
            <Select
              value={member?.physicalProjectKey ?? null}
              onValueChange={(value) => {
                if (typeof value === "string") {
                  setSelectedMemberKey(value);
                  setError(null);
                  setDeleting(null);
                  setSelectedPaths(new Set());
                }
              }}
            >
              <SelectTrigger size="sm" aria-label="Checkout">
                <SelectValue>
                  {member
                    ? `${member.environmentLabel ?? "Environment"} · ${member.workspaceRoot}`
                    : "Choose checkout"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectGroup>
                  {connectedMembers.map((entry) => (
                    <SelectItem key={entry.physicalProjectKey} value={entry.physicalProjectKey}>
                      {entry.environmentLabel ?? "Environment"} · {entry.workspaceRoot}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectPopup>
            </Select>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={!query.data?.isRepo}
            onClick={() => setCreating(true)}
          >
            <PlusIcon data-icon="inline-start" />
            Create worktree
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Refresh worktrees"
            disabled={!member}
            onClick={query.refresh}
          >
            <RefreshCwIcon data-icon="inline-start" />
            Refresh
          </Button>
          {selectedTargets.length > 0 && (
            <div className="ml-auto flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setSelectedPaths(new Set())}>
                Clear selection
              </Button>
              <Button
                size="sm"
                variant="destructive-outline"
                onClick={() => {
                  setError(null);
                  setDeleting(selectedTargets);
                }}
              >
                <Trash2Icon data-icon="inline-start" />
                Delete {selectedTargets.length}{" "}
                {selectedTargets.length === 1 ? "worktree" : "worktrees"}
              </Button>
            </div>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Threads can share a worktree. Deleting one keeps its threads and branch, but discards
          uncommitted changes.
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {!projectKey ? (
          <p className="text-sm text-muted-foreground">
            Choose a project above to manage its worktrees.
          </p>
        ) : !member ? (
          <p className="text-sm text-muted-foreground">
            Connect an environment with this project to manage its worktrees.
          </p>
        ) : query.error && !query.data ? (
          <p role="alert" className="text-sm text-destructive">
            {query.error}
          </p>
        ) : !query.data ? (
          <p className="text-sm text-muted-foreground">Loading worktrees…</p>
        ) : !query.data.isRepo ? (
          <p className="text-sm text-muted-foreground">This project is not a Git repository.</p>
        ) : worktrees.length === 0 ? (
          <div className="rounded-lg border">
            <Empty size="compact">
              <EmptyMedia variant="icon">
                <FolderGit2Icon />
              </EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>No additional worktrees</EmptyTitle>
                <EmptyDescription>
                  Create one to work on another branch in a separate folder.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        ) : (
          <div
            className="group/worktrees divide-y rounded-lg border"
            data-selecting={selectedTargets.length > 0 ? "" : undefined}
          >
            {rows.map(({ tree, target, usedBy, blocked }) => {
              const name = worktreeName(tree);
              return (
                <div key={tree.path} className="group/worktree flex items-start gap-3 p-4">
                  <span className="relative mt-0.5 flex size-4 shrink-0 items-center justify-center">
                    <FolderGit2Icon className="size-4 text-muted-foreground transition-opacity group-focus-within/worktree:opacity-0 group-hover/worktree:opacity-0 group-data-selecting/worktrees:opacity-0 pointer-coarse:opacity-0" />
                    <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-focus-within/worktree:opacity-100 group-hover/worktree:opacity-100 group-data-selecting/worktrees:opacity-100 pointer-coarse:opacity-100">
                      <Checkbox
                        aria-label={`Select ${name}`}
                        title={blocked ?? undefined}
                        checked={!blocked && selectedPaths.has(tree.path)}
                        disabled={!!blocked}
                        onCheckedChange={(checked) => toggleSelected(tree.path, checked)}
                      />
                    </span>
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{name}</p>
                    <p className="break-all text-xs text-muted-foreground">{tree.path}</p>
                    <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <GitBranchIcon className="size-3" />
                      {tree.branch ?? `Detached at ${tree.head.slice(0, 7)}`}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {usedBy.length} {usedBy.length === 1 ? "thread" : "threads"}
                      {tree.prunable ? " · Missing folder" : ""}
                      {blocked ? ` · ${blocked}` : ""}
                    </p>
                  </div>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Delete ${tree.branch ?? tree.path}`}
                    title={blocked ?? "Delete worktree"}
                    disabled={!!blocked}
                    onClick={() => {
                      setError(null);
                      setDeleting([target]);
                    }}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {creating && member && (
        <CreateWorktreeDialog
          cwd={member.workspaceRoot}
          environmentId={member.environmentId}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
          }}
        />
      )}
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleting(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {shownDeleting && shownDeleting.length > 1
                ? `Delete ${shownDeleting.length} worktrees?`
                : "Delete worktree?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {shownDeleting?.every((target) => target.worktree.prunable)
                ? shownDeleting.length > 1
                  ? "Their folders are already missing. This removes the stale Git worktree records."
                  : "Its folder is already missing. This removes the stale Git worktree record."
                : shownDeleting && shownDeleting.length > 1
                  ? "This permanently deletes the working copies and everything inside them."
                  : "This permanently deletes the working copy and everything inside it."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {shownDeleting && (
            <ul className="mx-6 mb-6 max-h-80 divide-y overflow-y-auto rounded-lg border bg-muted/40 text-sm max-sm:mb-4">
              {shownDeleting.map(({ worktree }) => (
                <li key={worktree.path} className="flex gap-3 px-3 py-2.5">
                  <FolderIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="break-all font-mono text-xs leading-5">{worktree.path}</span>
                    <span className="flex gap-1.5 text-xs text-muted-foreground">
                      <GitBranchIcon className="mt-0.5 size-3 shrink-0" />
                      {worktree.branch ? (
                        <span>
                          The <span className="font-medium text-foreground">{worktree.branch}</span>{" "}
                          branch and its commits are kept.
                        </span>
                      ) : (
                        <span>
                          Detached at{" "}
                          <span className="font-medium font-mono text-foreground">
                            {worktree.head.slice(0, 7)}
                          </span>
                          . Commits that aren&apos;t on a branch can be lost.
                        </span>
                      )}
                    </span>
                  </div>
                </li>
              ))}
              {deletingThreadCount > 0 && (
                <li className="flex gap-3 px-3 py-2.5">
                  <MessageSquareIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>
                    {shownDeleting.length > 1
                      ? `${deletingThreadCount} ${deletingThreadCount === 1 ? "thread is" : "threads are"} kept.`
                      : deletingThreadCount === 1
                        ? "Its thread is kept."
                        : `Its ${deletingThreadCount} threads are kept.`}
                  </span>
                </li>
              )}
            </ul>
          )}
          {(error || deletionBlocked) && (
            <p
              role="alert"
              className="whitespace-pre-line px-6 pb-6 text-sm text-destructive max-sm:pb-4"
            >
              {deletionBlocked ?? error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />} disabled={busy}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy || !!deletionBlocked}
              onClick={() => void deleteWorktrees()}
            >
              {busy
                ? "Deleting…"
                : deleting && deleting.length > 1
                  ? `Delete ${deleting.length} worktrees`
                  : "Delete worktree"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}
