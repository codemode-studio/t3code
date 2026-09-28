import type { EnvironmentId } from "@t3tools/contracts";

import { usePrimarySessionState } from "../environments/primary";
import { isElectron } from "../env";
import {
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
} from "../components/settings/ProviderSettingsPanel.logic";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { SettingsPageContainer, SettingsSearchTarget } from "../components/settings/settingsLayout";
import { searchableSetting } from "../components/settings/settingsSearch";
import { useEnvironmentSessionState } from "../state/session";
import { EnvironmentProfiles } from "./EnvironmentProfiles";

/**
 * Settings → Profiles: each company or client as a card holding its providers, default model and
 * projects. Profiles reference provider instances, which are per machine, so like Providers the
 * page edits one environment: the selected one, or the representative of the selection.
 */
export function ProfilesSettingsPage() {
  const { environment, scope } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {/* One stable anchor for settings search, whether or not profiles or an environment exist. */}
      <SettingsSearchTarget
        id={searchableSetting("provider-profiles").id}
        className="flex flex-col gap-8 outline-none"
      >
        {environment ? (
          // Keyed: with several environments selected, the representative can change without a
          // remount (one disconnects), and an open draft must not be saved into the next one.
          environment.entry.target._tag === "PrimaryConnectionTarget" ? (
            <PrimaryEnvironmentProfiles
              key={environment.environmentId}
              environmentId={environment.environmentId}
            />
          ) : (
            <RemoteEnvironmentProfiles
              key={environment.environmentId}
              environmentId={environment.environmentId}
            />
          )
        ) : (
          <p className="text-sm text-muted-foreground">
            {scope.kind === "environment"
              ? `Reconnect ${scope.label} to manage its profiles.`
              : "Connect an environment to manage profiles."}
          </p>
        )}
      </SettingsSearchTarget>
    </SettingsPageContainer>
  );
}

// Write access follows Providers: the desktop app owns its primary server, a browser session
// checks the scopes it was granted, and other environments report theirs.
function PrimaryEnvironmentProfiles({ environmentId }: { environmentId: EnvironmentId }) {
  const session = usePrimarySessionState();
  const access = resolvePrimaryOperateAccess({
    isPrimary: true,
    hasDesktopBridge: isElectron,
    session: session.data,
    isPending: session.isPending,
    hasError: session.error !== null,
  });
  return <EnvironmentProfiles environmentId={environmentId} access={access} />;
}

function RemoteEnvironmentProfiles({ environmentId }: { environmentId: EnvironmentId }) {
  const session = useEnvironmentSessionState(environmentId);
  const access = resolveRemoteOperateAccess({
    session: session.data,
    isPending: session.isPending,
    hasError: session.hasError,
  });
  return <EnvironmentProfiles environmentId={environmentId} access={access} />;
}
