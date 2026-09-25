import { useNavigation } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  isProviderSendTurnSupportedImageMimeType,
  type EnvironmentId,
  type Note,
  type NoteError,
  type ProjectId,
} from "@t3tools/contracts";
import * as ImagePicker from "expo-image-picker";
import { useMemo, useState } from "react";
import { Alert, Image, Pressable, ScrollView, TextInput, View } from "react-native";
import { Markdown } from "react-native-nitro-markdown";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { AppText as Text } from "../../components/AppText";
import { attachmentEnvironment } from "../../state/attachments";
import { useAssetUrl } from "../../state/assets";
import { useProjects } from "../../state/entities";
import { notesEnvironment, useNotes, type EnvironmentNote } from "../../state/notes";
import { useDebouncedValue } from "../../state/queries";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceState } from "../../state/workspace";
import { queueNoteForChat } from "./pendingNoteForChat";

type Draft = {
  title: string;
  body: string;
  tags: string;
  projectId: ProjectId | null;
  environmentId: EnvironmentId;
};
const noteKey = (note: EnvironmentNote) => `${note.environmentId}:${note.id}`;
const EMPTY_NOTE_ATOM = Atom.make(AsyncResult.initial<Note, NoteError>(false));
const draftFromNote = (note: Note, environmentId: EnvironmentId): Draft => ({
  title: note.title,
  body: note.body,
  tags: note.tags.join(", "),
  projectId: note.projectId,
  environmentId,
});
const tagsFromText = (tags: string) =>
  [
    ...new Set(
      tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ].slice(0, 20);

function Action({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      className="rounded-lg bg-subtle px-3 py-2"
    >
      <Text className="text-sm text-foreground">{label}</Text>
    </Pressable>
  );
}

function NoteImage({
  environmentId,
  attachmentId,
}: {
  environmentId: EnvironmentId;
  attachmentId: string;
}) {
  const url = useAssetUrl(environmentId, { _tag: "attachment", attachmentId });
  return url ? (
    <Image source={{ uri: url }} className="my-2 h-52 w-full rounded-xl" resizeMode="contain" />
  ) : null;
}

function NotePreview({ environmentId, body }: { environmentId: EnvironmentId; body: string }) {
  const parts = body.split(/(!\[[^\]]*\]\(t3-note-image:\/\/[a-z0-9_-]+\))/gi);
  return (
    <View>
      {parts.map((part, index) => {
        const image = /^!\[[^\]]*\]\(t3-note-image:\/\/([a-z0-9_-]+)\)$/i.exec(part);
        return image ? (
          <NoteImage key={index} environmentId={environmentId} attachmentId={image[1]!} />
        ) : part.trim() ? (
          <Markdown key={index} options={{ gfm: true }}>
            {part}
          </Markdown>
        ) : null;
      })}
    </View>
  );
}

export function NotesRouteScreen() {
  const navigation = useNavigation();
  const { environments } = useWorkspaceState();
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query.trim(), 180);
  const { notes } = useNotes(debouncedQuery);
  const projects = useProjects();
  const create = useAtomCommand(notesEnvironment.create);
  const update = useAtomCommand(notesEnvironment.update);
  const remove = useAtomCommand(notesEnvironment.remove);
  const upload = useAtomCommand(attachmentEnvironment.createUploadUrl);
  const [selected, setSelected] = useState<EnvironmentNote | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [creating, setCreating] = useState(false);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const detailResult = useAtomValue(
    selected
      ? notesEnvironment.get({ environmentId: selected.environmentId, input: { id: selected.id } })
      : EMPTY_NOTE_ATOM,
  );
  const detail = Option.getOrNull(AsyncResult.value(detailResult));
  const editor =
    draft ?? (selected && detail ? draftFromNote(detail, selected.environmentId) : null);
  const prepared = usePreparedConnection(editor?.environmentId ?? null);
  const tags = useMemo(() => [...new Set(notes.flatMap((note) => note.tags))].sort(), [notes]);
  const visible = notes.filter((note) => !tagFilter || note.tags.includes(tagFilter));
  const patch = (value: Partial<Draft>) =>
    setDraft((current) => ({ ...(current ?? editor!), ...value }));
  const save = async () => {
    if (!editor?.title.trim()) return;
    setBusy(true);
    try {
      const input = {
        title: editor.title.trim(),
        body: editor.body,
        tags: tagsFromText(editor.tags),
        projectId: editor.projectId,
      };
      const result = creating
        ? await create({
            environmentId: editor.environmentId,
            input: { ...input, sourceThreadId: null, sourceMessageId: null },
          })
        : selected &&
          (await update({
            environmentId: selected.environmentId,
            input: { ...input, id: selected.id },
          }));
      if (result?._tag === "Success") {
        setQuery("");
        setCreating(false);
        setDraft(null);
        setSelected({ ...result.value, environmentId: editor.environmentId });
      }
    } finally {
      setBusy(false);
    }
  };
  const deleteSelected = () => {
    if (!selected) return;
    Alert.alert("Delete note?", selected.title, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void remove({ environmentId: selected.environmentId, input: { id: selected.id } }).then(
            (result) => {
              if (result._tag === "Success") {
                setQuery("");
                setSelected(null);
                setDraft(null);
              }
            },
          );
        },
      },
    ]);
  };
  const addToChat = () => {
    if (!selected) return;
    const project =
      projects.find(
        (item) => item.environmentId === selected.environmentId && item.id === selected.projectId,
      ) ?? projects.find((item) => item.environmentId === selected.environmentId);
    if (!project) {
      Alert.alert("No project", "Add a project on this environment to start a chat.");
      return;
    }
    const noteRequestId = queueNoteForChat(selected.environmentId, selected);
    navigation.navigate("NewTaskSheet", {
      screen: "NewTaskDraft",
      params: {
        environmentId: project.environmentId,
        projectId: project.id,
        title: project.title,
        noteRequestId,
      },
    });
  };
  const addImage = async () => {
    if (!editor || prepared._tag !== "Some") return;
    try {
      const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 1,
      });
      const asset = picked.assets?.[0];
      if (picked.canceled || !asset) return;
      const mimeType = asset.mimeType ?? "image/jpeg";
      if (!isProviderSendTurnSupportedImageMimeType(mimeType)) {
        Alert.alert("Unsupported image", "Choose a GIF, JPEG, PNG, or WebP image.");
        return;
      }
      const { File, UploadType } = await import("expo-file-system");
      const file = new File(asset.uri);
      const minted = await upload({
        environmentId: editor.environmentId,
        input: {
          name: asset.fileName ?? "note-image.jpg",
          mimeType: mimeType as "image/png",
          sizeBytes: file.size,
        },
      });
      if (minted._tag !== "Success") return;
      const url = resolveAssetUrl(prepared.value.httpBaseUrl, minted.value.relativeUrl);
      const response =
        url &&
        (await file.upload(url, {
          httpMethod: "POST",
          uploadType: UploadType.BINARY_CONTENT,
          headers: { "Content-Type": mimeType },
        }));
      if (!response || response.status < 200 || response.status >= 300) {
        Alert.alert("Image upload failed");
        return;
      }
      patch({
        body: `${editor.body}${editor.body ? "\n\n" : ""}![${asset.fileName ?? "Image"}](t3-note-image://${minted.value.attachmentId})`,
      });
    } catch {
      Alert.alert("Image upload failed", "Try choosing the image again.");
    }
  };

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-3 p-4 pb-16">
      <View className="flex-row items-center justify-between">
        <Text className="text-2xl font-t3-bold text-foreground">Notes</Text>
        <Action
          label="New note"
          onPress={() => {
            const environmentId = environments[0]?.environmentId;
            if (!environmentId) return;
            setSelected(null);
            setCreating(true);
            setPreview(false);
            setDraft({ title: "", body: "", tags: "", projectId: null, environmentId });
          }}
        />
      </View>
      <TextInput
        accessibilityLabel="Search notes"
        placeholder="Search notes"
        value={query}
        onChangeText={setQuery}
        className="rounded-xl bg-subtle px-3 py-2 text-foreground"
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-2"
      >
        <Action label="All tags" onPress={() => setTagFilter(null)} />
        {tags.map((tag) => (
          <Action key={tag} label={tag} onPress={() => setTagFilter(tag)} />
        ))}
      </ScrollView>
      {visible.map((note) => (
        <Pressable
          key={noteKey(note)}
          onPress={() => {
            setSelected(note);
            setDraft(null);
            setCreating(false);
            setPreview(false);
          }}
          className="rounded-xl bg-subtle p-3"
        >
          <Text className="font-t3-medium text-foreground">{note.title}</Text>
          <Text className="text-xs text-foreground-secondary">
            {environments.find((environment) => environment.environmentId === note.environmentId)
              ?.environmentLabel ?? note.environmentId}
          </Text>
        </Pressable>
      ))}
      {visible.length === 0 && (
        <Text className="text-foreground-secondary">
          No notes yet. Create one or save a transcript message.
        </Text>
      )}
      {editor && (
        <View className="mt-3 gap-3 border-t border-border pt-4">
          <TextInput
            accessibilityLabel="Note title"
            placeholder="Title"
            value={editor.title}
            onChangeText={(title) => patch({ title })}
            className="rounded-xl bg-subtle px-3 py-2 text-foreground"
          />
          <Text className="text-xs text-foreground-secondary">
            Environment:{" "}
            {environments.find((environment) => environment.environmentId === editor.environmentId)
              ?.environmentLabel ?? editor.environmentId}
          </Text>
          {creating && environments.length > 1 && (
            <ScrollView horizontal contentContainerClassName="gap-2">
              {environments.map((environment) => (
                <Action
                  key={environment.environmentId}
                  label={environment.environmentLabel}
                  onPress={() =>
                    patch({ environmentId: environment.environmentId, projectId: null })
                  }
                />
              ))}
            </ScrollView>
          )}
          <ScrollView horizontal contentContainerClassName="gap-2">
            <Action label="All projects" onPress={() => patch({ projectId: null })} />
            {projects
              .filter((project) => project.environmentId === editor.environmentId)
              .map((project) => (
                <Action
                  key={project.id}
                  label={project.title}
                  onPress={() => patch({ projectId: project.id })}
                />
              ))}
          </ScrollView>
          <TextInput
            accessibilityLabel="Tags"
            placeholder="Tags, separated by commas"
            value={editor.tags}
            onChangeText={(tags) => patch({ tags })}
            className="rounded-xl bg-subtle px-3 py-2 text-foreground"
          />
          <View className="flex-row flex-wrap gap-2">
            <Action
              label={preview ? "Edit Markdown" : "Preview"}
              onPress={() => setPreview(!preview)}
            />
            <Action label="Add image" onPress={() => void addImage()} />
            <Action
              label={busy ? "Saving…" : "Save"}
              onPress={() => {
                if (!busy) void save();
              }}
            />
            {selected && <Action label="Delete" onPress={deleteSelected} />}
            {selected && <Action label="Add to chat" onPress={addToChat} />}
          </View>
          {preview ? (
            <NotePreview environmentId={editor.environmentId} body={editor.body} />
          ) : (
            <TextInput
              accessibilityLabel="Note Markdown"
              multiline
              placeholder="Write a note…"
              value={editor.body}
              onChangeText={(body) => patch({ body })}
              textAlignVertical="top"
              className="min-h-64 rounded-xl bg-subtle p-3 text-foreground"
            />
          )}
          {selected?.sourceThreadId && (
            <Action
              label="Open source thread"
              onPress={() =>
                navigation.navigate("Thread", {
                  environmentId: selected.environmentId,
                  threadId: selected.sourceThreadId!,
                })
              }
            />
          )}
        </View>
      )}
    </ScrollView>
  );
}
