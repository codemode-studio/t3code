import {
  profileScopeOfProject,
  profileScopeProjectKey,
  projectMatchesScope,
} from "@t3tools/client-runtime/state/profile-scope";
import { useEffect, useRef, type ReactNode } from "react";

import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { ProfileScopeShortcuts } from "./ProfileSwitcher";
import { useProfileScopeState } from "./useProfileScope";

/**
 * The sidebar shows the profile of the project you are in. Opening a thread from a notification,
 * search or link, or picking another project for a draft, switches to that project's profile.
 * It reacts to navigation only, so choosing a profile by hand while a thread is open sticks.
 */
function ProfileFollowsActiveProject() {
  const { activeDraftThread, activeThread } = useHandleNewThread();
  const thread = activeThread ?? activeDraftThread;
  const projectKey = thread ? profileScopeProjectKey(thread.environmentId, thread.projectId) : null;
  const { scope, setScope, projectProfiles } = useProfileScopeState();
  const followedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (projectKey === null || projectKey === followedKeyRef.current) return;
    // Wait for the project's snapshot; until then its profile is unknown, not "none".
    if (!projectProfiles.has(projectKey)) return;
    followedKeyRef.current = projectKey;
    const profileId = projectProfiles.get(projectKey);
    if (!projectMatchesScope(scope, profileId)) setScope(profileScopeOfProject(profileId));
  }, [projectKey, projectProfiles, scope, setScope]);
  return null;
}

/** Wraps the app sidebar's content with the profile shortcuts and the follow-the-project rule. */
export function ProfileAwareSidebar({ children }: { children: ReactNode }) {
  return (
    <>
      <ProfileScopeShortcuts />
      <ProfileFollowsActiveProject />
      {children}
    </>
  );
}
