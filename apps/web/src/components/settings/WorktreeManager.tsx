import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { VcsListedWorktree } from "@t3tools/contracts";
import { FolderGit2Icon, GitBranchIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { useThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { Button } from "../ui/button";
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

export function WorktreeManager() {
  const { scope, groups, selectScope, connectedEnvironments } = useSettingsScope();
  const [selectedMemberKey, setSelectedMemberKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<VcsListedWorktree | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threads = useThreadShells();
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
  const threadsByWorktree = new Map<string, Array<(typeof threads)[number]>>();
  for (const thread of threads) {
    if (thread.environmentId !== member?.environmentId || !thread.worktreePath) continue;
    const worktreeThreads = threadsByWorktree.get(thread.worktreePath);
    if (worktreeThreads) worktreeThreads.push(thread);
    else threadsByWorktree.set(thread.worktreePath, [thread]);
  }
  const associatedThreads = (tree: VcsListedWorktree) => threadsByWorktree.get(tree.path) ?? [];
  const deletingThreads = deleting ? associatedThreads(deleting) : [];
  const deleteWorktree = async () => {
    if (!deleting || !member || busy) return;
    setBusy(true);
    setError(null);
    const result = await removeWorktree({
      environmentId: member.environmentId,
      input: { cwd: member.workspaceRoot, path: deleting.path, force: true },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setDeleting(null);
    } else {
      setError(commandError(result));
    }
  };
  return (
    <SettingsSection id="storage-manage-worktrees" title="Manage worktrees">
      <div className="flex flex-col gap-4 p-4">
        <p className="text-sm text-muted-foreground">
          Create and remove additional worktrees for a project.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={projectKey}
            onValueChange={(value) => {
              if (typeof value === "string") {
                selectScope({ project: value });
                setSelectedMemberKey(null);
                setError(null);
                setDeleting(null);
              }
            }}
          >
            <SelectTrigger size="sm" aria-label="Project">
              <SelectValue>
                {scope.kind === "project" || scope.kind === "checkout"
                  ? scope.group.displayName
                  : "Choose project"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectGroup>
                {groups.map((group) => (
                  <SelectItem key={group.projectKey} value={group.projectKey}>
                    {group.displayName}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectPopup>
          </Select>
          {connectedMembers.length > 1 && (
            <Select
              value={member?.physicalProjectKey ?? null}
              onValueChange={(value) => {
                if (typeof value === "string") {
                  setSelectedMemberKey(value);
                  setError(null);
                  setDeleting(null);
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
          <p className="text-sm text-muted-foreground">Choose a project to manage its worktrees.</p>
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
          <div className="divide-y rounded-lg border">
            {worktrees.map((tree) => {
              const usedBy = associatedThreads(tree);
              const running = usedBy.some(
                (thread) =>
                  thread.session?.status === "running" || thread.backgroundLiveness != null,
              );
              const blocked = tree.locked
                ? "Locked in Git"
                : tree.path === member?.workspaceRoot
                  ? "Selected project checkout"
                  : !tree.branch
                    ? "Detached worktree"
                    : running
                      ? "A thread is running here"
                      : null;
              return (
                <div key={tree.path} className="flex items-start gap-3 p-4">
                  <FolderGit2Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {tree.path.split(/[\\/]/).at(-1) ?? tree.path}
                    </p>
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
                      setDeleting(tree);
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
            <AlertDialogTitle>Delete worktree?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.prunable
                ? `This removes the stale Git worktree record for ${deleting.path}.`
                : `This permanently removes the working copy at ${deleting?.path}. Uncommitted and untracked changes are discarded.`}{" "}
              Its branch, commits, and {deletingThreads.length} associated{" "}
              {deletingThreads.length === 1 ? "thread" : "threads"} are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="px-6 text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />} disabled={busy}>
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" disabled={busy} onClick={() => void deleteWorktree()}>
              {busy ? "Deleting…" : "Delete worktree"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}
