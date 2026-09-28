import { createFileRoute } from "@tanstack/react-router";

import { ProfilesSettingsPage } from "../profileScope/ProfilesSettingsPage";

export const Route = createFileRoute("/settings/profiles")({
  component: ProfilesSettingsPage,
});
