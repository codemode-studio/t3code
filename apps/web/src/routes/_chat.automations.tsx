import { createFileRoute } from "@tanstack/react-router";

import { AutomationsPage } from "../components/automations/AutomationsPage";

interface AutomationsSearch {
  readonly automation?: string;
}

export const Route = createFileRoute("/_chat/automations")({
  validateSearch: (search: Record<string, unknown>): AutomationsSearch =>
    typeof search.automation === "string" ? { automation: search.automation } : {},
  component: AutomationsRouteView,
});

function AutomationsRouteView() {
  const { automation } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <AutomationsPage
      selectedKey={automation ?? null}
      onSelect={(key) => void navigate({ search: key ? { automation: key } : {} })}
    />
  );
}
