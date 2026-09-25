import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { ArrowUpRightIcon, FileTextIcon, PlusIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import {
  isProviderSendTurnSupportedImageMimeType,
  type Note,
  type NoteError,
  EnvironmentId,
  NoteId,
  type ProjectId,
} from "@t3tools/contracts";
import { useAssetUrls, resolveAssetUrl } from "../../assets/assetUrls";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { queueNoteForChat } from "../../lib/noteChatBus";
import { attachmentEnvironment } from "../../state/attachments";
import { useProjects } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { notesEnvironment, useNotes, type EnvironmentNote } from "../../state/notes";
import { useDebouncedValue } from "../../state/queries";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

interface Draft {
  title: string;
  body: string;
  tags: string;
  projectId: ProjectId | null;
  environmentId: EnvironmentId;
}

const keyOf = (note: EnvironmentNote) => `${note.environmentId}:${note.id}`;
const NoteSelection = Schema.Struct({ environmentId: EnvironmentId, id: NoteId });
const EMPTY_NOTE_ATOM = Atom.make(AsyncResult.initial<Note, NoteError>(false));
const draftOf = (note: Note, environmentId: EnvironmentId): Draft => ({
  title: note.title,
  body: note.body,
  tags: note.tags.join(", "),
  projectId: note.projectId,
  environmentId,
});
const parseTags = (tags: string) =>
  [
    ...new Set(
      tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ].slice(0, 20);

function NotePreview({ body, environmentId }: { body: string; environmentId: EnvironmentId }) {
  const ids = useMemo(
    () => [
      ...new Set([...body.matchAll(/t3-note-image:\/\/([a-z0-9_-]+)/gi)].map((match) => match[1]!)),
    ],
    [body],
  );
  const resources = useMemo(
    () => ids.map((attachmentId) => ({ _tag: "attachment" as const, attachmentId })),
    [ids],
  );
  const urls = useAssetUrls(environmentId, resources);
  const rendered = ids.reduce(
    (text, id, index) => text.replaceAll(`t3-note-image://${id}`, urls[index] ?? ""),
    body,
  );
  return <ChatMarkdown text={rendered} cwd={undefined} environmentId={environmentId} />;
}

export function NotesPage({
  selectedKey,
  onSelect,
}: {
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
}) {
  const navigate = useNavigate();
  const newThread = useNewThreadHandler();
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query.trim(), 180);
  const { notes, isPending } = useNotes(debouncedQuery);
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  const create = useAtomCommand(notesEnvironment.create);
  const update = useAtomCommand(notesEnvironment.update);
  const remove = useAtomCommand(notesEnvironment.remove);
  const upload = useAtomCommand(attachmentEnvironment.createUploadUrl);
  const [tagFilter, setTagFilter] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const selection = useMemo(() => {
    const separator = selectedKey?.lastIndexOf(":") ?? -1;
    if (!selectedKey || separator < 1) return null;
    return Option.getOrNull(
      Schema.decodeUnknownOption(NoteSelection)({
        environmentId: selectedKey.slice(0, separator),
        id: selectedKey.slice(separator + 1),
      }),
    );
  }, [selectedKey]);
  const detailResult = useAtomValue(
    selection
      ? notesEnvironment.get({
          environmentId: selection.environmentId,
          input: { id: selection.id },
        })
      : EMPTY_NOTE_ATOM,
  );
  const detail = Option.getOrNull(AsyncResult.value(detailResult));
  const selected =
    selection && detail ? { ...detail, environmentId: selection.environmentId } : null;
  const editor = draft ?? (selected && detail ? draftOf(detail, selected.environmentId) : null);
  const prepared = usePreparedConnection(editor?.environmentId ?? null);
  const visible = notes.filter((note) => !tagFilter || note.tags.includes(tagFilter));
  const tags = [...new Set(notes.flatMap((note) => note.tags))].sort();
  const patch = (next: Partial<Draft>) =>
    setDraft((current) => {
      const base = current ?? editor;
      return base ? { ...base, ...next } : null;
    });
  const startCreate = () => {
    const environmentId = primaryEnvironmentId ?? environments[0]?.environmentId;
    if (!environmentId) return;
    onSelect(null);
    setCreating(true);
    setPreview(false);
    setDraft({ title: "", body: "", tags: "", projectId: null, environmentId });
  };
  const select = (note: EnvironmentNote) => {
    setCreating(false);
    setDraft(null);
    setPreview(false);
    onSelect(keyOf(note));
  };
  const save = async () => {
    if (!editor || !editor.title.trim()) return;
    setSaving(true);
    try {
      const input = {
        title: editor.title.trim(),
        body: editor.body,
        tags: parseTags(editor.tags),
        projectId: editor.projectId,
      };
      const result = creating
        ? await create({
            environmentId: editor.environmentId,
            input: {
              ...input,
              sourceThreadId: null,
              sourceMessageId: null,
            },
          })
        : selected &&
          (await update({
            environmentId: selected.environmentId,
            input: { ...input, id: selected.id },
          }));
      if (result?._tag === "Success") {
        setQuery("");
        setDraft(null);
        setCreating(false);
        onSelect(`${editor.environmentId}:${result.value.id}`);
        toastManager.add({ type: "success", title: "Note saved" });
      }
    } finally {
      setSaving(false);
    }
  };
  const deleteSelected = async () => {
    if (!selected || !window.confirm(`Delete "${selected.title}"?`)) return;
    const result = await remove({
      environmentId: selected.environmentId,
      input: { id: selected.id },
    });
    if (result._tag === "Success") {
      setQuery("");
      onSelect(null);
      setDraft(null);
    }
  };
  const addToChat = async () => {
    if (!selected) return;
    const project =
      projects.find(
        (candidate) =>
          candidate.environmentId === selected.environmentId && candidate.id === selected.projectId,
      ) ?? projects.find((candidate) => candidate.environmentId === selected.environmentId);
    if (!project) {
      toastManager.add({
        type: "error",
        title: "Add a project on this environment to start a chat",
      });
      return;
    }
    queueNoteForChat(selected.environmentId, selected);
    await newThread(scopeProjectRef(selected.environmentId, project.id));
  };
  const addImage = async (file: File) => {
    if (!editor || !file.type.startsWith("image/") || prepared._tag === "None") return;
    if (!isProviderSendTurnSupportedImageMimeType(file.type)) {
      toastManager.add({ type: "error", title: "Use a GIF, JPEG, PNG, or WebP image" });
      return;
    }
    try {
      const result = await upload({
        environmentId: editor.environmentId,
        input: { name: file.name, mimeType: file.type as "image/png", sizeBytes: file.size },
      });
      if (result._tag !== "Success") return;
      const url = resolveAssetUrl(prepared.value.httpBaseUrl, result.value.relativeUrl);
      if (!url) return;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!response.ok) {
        toastManager.add({ type: "error", title: "Image upload failed" });
        return;
      }
      patch({
        body: `${editor.body}${editor.body ? "\n\n" : ""}![${file.name}](t3-note-image://${result.value.attachmentId})`,
      });
    } catch {
      toastManager.add({ type: "error", title: "Image upload failed" });
    }
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="border-b">
          <WorkspaceBreadcrumb ariaLabel="Notes breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem current>
              <h1 className="flex items-center gap-2">
                <FileTextIcon className="size-4 text-muted-foreground" />
                Notes
              </h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-72 shrink-0 flex-col border-r max-sm:w-48">
            <div className="flex items-center gap-1 border-b p-2">
              <InputGroup className="min-w-0 flex-1">
                <InputGroupAddon>
                  <SearchIcon />
                </InputGroupAddon>
                <InputGroupInput
                  size="sm"
                  aria-label="Search notes"
                  placeholder="Search notes"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </InputGroup>
              <Button size="icon-sm" variant="ghost" aria-label="New note" onClick={startCreate}>
                <PlusIcon />
              </Button>
            </div>
            <div className="border-b p-2">
              <Select value={tagFilter} onValueChange={(value) => setTagFilter(value ?? "")}>
                <SelectTrigger size="sm" aria-label="Filter by tag">
                  <SelectValue>{tagFilter || "All tags"}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="">All tags</SelectItem>
                  {tags.map((tag) => (
                    <SelectItem key={tag} value={tag}>
                      {tag}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col gap-0.5 p-2">
                {visible.map((note) => (
                  <button
                    key={keyOf(note)}
                    type="button"
                    onClick={() => select(note)}
                    className={cn(
                      "flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left text-sm hover:bg-accent/60",
                      selectedKey === keyOf(note) && "bg-accent",
                    )}
                  >
                    <span className="truncate text-sm font-medium">{note.title}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {environments.find(
                        (environment) => environment.environmentId === note.environmentId,
                      )?.label ?? note.environmentId}
                    </span>
                  </button>
                ))}
                {!isPending && visible.length === 0 && (
                  <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                    No notes yet. Create one or save a transcript message.
                  </p>
                )}
              </div>
            </ScrollArea>
          </aside>
          <main className="min-w-0 flex-1 overflow-y-auto p-4">
            {editor ? (
              <div className="mx-auto flex max-w-3xl flex-col gap-4">
                <div className="flex flex-wrap items-start gap-3">
                  <input
                    aria-label="Note title"
                    placeholder="Untitled"
                    value={editor.title}
                    onChange={(event) => patch({ title: event.target.value })}
                    className="min-w-40 flex-1 bg-transparent text-xl font-semibold outline-hidden placeholder:text-muted-foreground/60"
                  />
                  <div className="flex shrink-0 items-center gap-2">
                    {selected && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label="Delete note"
                        onClick={() => void deleteSelected()}
                      >
                        <Trash2Icon />
                      </Button>
                    )}
                    {selected && (
                      <Button size="sm" variant="outline" onClick={() => void addToChat()}>
                        Add to chat
                      </Button>
                    )}
                    <Button
                      size="sm"
                      disabled={saving || !editor.title.trim()}
                      onClick={() => void save()}
                    >
                      Save
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  {creating && (
                    <div className="w-48 max-w-full">
                      <Select
                        value={editor.environmentId}
                        onValueChange={(value) => {
                          const environment = environments.find(
                            (entry) => entry.environmentId === value,
                          );
                          if (environment) {
                            patch({ environmentId: environment.environmentId, projectId: null });
                          }
                        }}
                      >
                        <SelectTrigger size="sm" aria-label="Environment">
                          <SelectValue>
                            {environments.find(
                              (environment) => environment.environmentId === editor.environmentId,
                            )?.label ?? editor.environmentId}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectPopup>
                          {environments.map((environment) => (
                            <SelectItem
                              key={environment.environmentId}
                              value={environment.environmentId}
                            >
                              {environment.label}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    </div>
                  )}
                  {!creating && (
                    <span className="text-muted-foreground">
                      {environments.find(
                        (environment) => environment.environmentId === editor.environmentId,
                      )?.label ?? editor.environmentId}
                    </span>
                  )}
                  <div className="w-40 max-w-full">
                    <Select
                      value={editor.projectId ?? ""}
                      onValueChange={(value) => {
                        if (!value) {
                          patch({ projectId: null });
                          return;
                        }
                        const project = projects.find(
                          (entry) =>
                            entry.environmentId === editor.environmentId && entry.id === value,
                        );
                        if (project) patch({ projectId: project.id });
                      }}
                    >
                      <SelectTrigger size="sm" aria-label="Project">
                        <SelectValue>
                          {projects.find(
                            (project) =>
                              project.environmentId === editor.environmentId &&
                              project.id === editor.projectId,
                          )?.title ?? "All projects"}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        <SelectItem value="">All projects</SelectItem>
                        {projects
                          .filter((project) => project.environmentId === editor.environmentId)
                          .map((project) => (
                            <SelectItem key={project.id} value={project.id}>
                              {project.title}
                            </SelectItem>
                          ))}
                      </SelectPopup>
                    </Select>
                  </div>
                  {selected?.sourceThreadId && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void navigate({
                          to: "/$environmentId/$threadId",
                          params: {
                            environmentId: selected.environmentId,
                            threadId: selected.sourceThreadId!,
                          },
                        })
                      }
                    >
                      Open source thread
                      <ArrowUpRightIcon />
                    </Button>
                  )}
                </div>
                <Input
                  aria-label="Tags"
                  placeholder="Tags, separated by commas"
                  value={editor.tags}
                  onChange={(event) => patch({ tags: event.target.value })}
                />
                <div className="flex gap-2">
                  <Button
                    size="xs"
                    variant={!preview ? "secondary" : "ghost"}
                    onClick={() => setPreview(false)}
                  >
                    Markdown
                  </Button>
                  <Button
                    size="xs"
                    variant={preview ? "secondary" : "ghost"}
                    onClick={() => setPreview(true)}
                  >
                    Preview
                  </Button>
                </div>
                {preview ? (
                  <NotePreview body={editor.body} environmentId={editor.environmentId} />
                ) : (
                  <div
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      const file = event.dataTransfer.files[0];
                      if (file) void addImage(file);
                    }}
                  >
                    <Textarea
                      size="editor"
                      aria-label="Note Markdown"
                      placeholder="Write a note… Drop images here."
                      value={editor.body}
                      onChange={(event) => patch({ body: event.target.value })}
                    />
                  </div>
                )}
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Select a note
              </div>
            )}
          </main>
        </div>
      </div>
    </SidebarInset>
  );
}
