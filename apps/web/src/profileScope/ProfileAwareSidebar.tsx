import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  followNavigation,
  profileScopeProjectKey,
  type ProfileNavigation,
} from "@t3tools/client-runtime/state/profile-scope";
import { useParams } from "@tanstack/react-router";
import { useEffect, useRef, type ReactNode } from "react";

import { useSidebar } from "../components/ui/sidebar";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { CollapsedThreadSidebar } from "./CollapsedThreadSidebar";
import { ProfileScopeShortcuts } from "./ProfileSwitcher";
import { SidebarContentSlot } from "./SidebarContentSlot";
import { useProfileScopeState } from "./useProfileScope";
import "./profileSidebar.css";

/**
 * The sidebar shows the profile of the thread you open. Opening one from a notification, search
 * or link, or picking another project for a draft, switches to its project's profile. A profile
 * chosen by hand holds until the next navigation.
 */
function ProfileFollowsActiveProject() {
  const routeKey = useParams({
    strict: false,
    select: (params) => {
      const target = resolveThreadRouteTarget(params);
      if (target === null) return null;
      return target.kind === "server"
        ? `thread:${scopedThreadKey(target.threadRef)}`
        : `draft:${target.draftId}`;
    },
  });
  const { activeDraftThread, activeThread } = useHandleNewThread();
  const thread = activeThread ?? activeDraftThread;
  const projectKey = thread ? profileScopeProjectKey(thread.environmentId, thread.projectId) : null;
  const { scope, setScope, projectProfiles } = useProfileScopeState();
  const followedRef = useRef<ProfileNavigation | null>(null);
  useEffect(() => {
    if (routeKey === null || projectKey === null) return;
    const current = { routeKey, projectKey };
    const outcome = followNavigation({
      followed: followedRef.current,
      current,
      scope,
      projectProfiles,
    });
    // Until the project's snapshot lands its profile is unknown, not "none": try again then.
    if (outcome.kind === "pending") return;
    followedRef.current = current;
    if (outcome.kind === "switch") setScope(outcome.scope);
  }, [projectKey, projectProfiles, routeKey, scope, setScope]);
  return null;
}

/**
 * The app sidebar's content: the expanded sidebar it wraps, and the icon rail in its place while
 * collapsed on desktop. Mobile keeps its sheet, which only ever shows the expanded sidebar.
 */
export function ProfileAwareSidebar({ children }: { children: ReactNode }) {
  const { state, isMobile } = useSidebar();
  return (
    <>
      <ProfileScopeShortcuts />
      <ProfileFollowsActiveProject />
      <SidebarContentSlot
        showRail={state === "collapsed" && !isMobile}
        rail={<CollapsedThreadSidebar />}
      >
        {children}
      </SidebarContentSlot>
    </>
  );
}
