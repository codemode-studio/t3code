import { createFileRoute } from "@tanstack/react-router";
import { NotesPage } from "../components/notes/NotesPage";

interface NotesSearch {
  readonly note?: string;
}

export const Route = createFileRoute("/_chat/notes")({
  validateSearch: (search: Record<string, unknown>): NotesSearch =>
    typeof search.note === "string" ? { note: search.note } : {},
  component: NotesRouteView,
});

function NotesRouteView() {
  const { note } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <NotesPage
      selectedKey={note ?? null}
      onSelect={(key) => void navigate({ search: key ? { note: key } : {} })}
    />
  );
}
