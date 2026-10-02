import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import {
  ChartNoAxesColumnIcon,
  FileTextIcon,
  MessageSquareIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  ZapIcon,
} from "lucide-react";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";

import { openCommandPalette } from "../commandPaletteBus";
import { ProjectFavicon } from "../components/ProjectFavicon";
import { resolveThreadLastVisitedAt, resolveThreadStatusPill } from "../components/Sidebar.logic";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { useProjects, useThreadShells } from "../state/entities";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { profileScopeProjectKey as projectScopeKey } from "@t3tools/client-runtime/state/profile-scope";
import { partitionRailThreads } from "./collapsedThreadSidebar.logic";
import { ProfileSwitcher } from "./ProfileSwitcher";
import { useProfileScopedProjectKeys, useProfileScopeState } from "./useProfileScope";

function RailButton({
  label,
  ariaLabel,
  edgeColor = null,
  isActive = false,
  onClick,
  children,
}: {
  label: ReactNode;
  ariaLabel?: string;
  edgeColor?: string | null;
  isActive?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <SidebarMenuItem>
      {edgeColor ? (
        <span
          aria-hidden
          className="absolute top-1.5 bottom-1.5 -left-1.5 w-0.5 rounded-full"
          style={{ backgroundColor: edgeColor }}
        />
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              size="icon"
              isActive={isActive}
              onClick={onClick}
              aria-label={ariaLabel ?? (typeof label === "string" ? label : undefined)}
            />
          }
        >
          {children}
        </TooltipTrigger>
        <TooltipPopup side="right">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

const RailThreadButton = memo(function RailThreadButton({
  thread,
  isActive,
  profileColor,
}: {
  thread: EnvironmentThreadShell;
  isActive: boolean;
  /** Set while showing every profile, so each thread still reads as its company's. */
  profileColor: string | null;
}) {
  const navigate = useNavigate();
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const localLastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const project = useProjects().find(
    (candidate) =>
      candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
  );
  const status = resolveThreadStatusPill({ thread: { ...thread, lastVisitedAt } });
  return (
    <RailButton
      ariaLabel={status ? `${thread.title}, ${status.label}` : thread.title}
      edgeColor={profileColor}
      isActive={isActive}
      onClick={() =>
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        })
      }
      label={
        <span className="flex max-w-64 flex-col">
          <span className="truncate font-medium">{thread.title}</span>
          <span className="truncate text-muted-foreground">
            {project?.title ?? "Unknown project"}
            {status ? ` · ${status.label}` : ""}
          </span>
        </span>
      }
    >
      <span className="relative flex">
        {project ? (
          <ProjectFavicon project={project} className="size-4" />
        ) : (
          <MessageSquareIcon className="size-4" />
        )}
        {/* Static on purpose: a rail of pulsing dots would repaint every frame. */}
        {status ? (
          <span
            aria-hidden
            className={cn(
              "absolute -right-1.5 -bottom-1.5 size-2.5 rounded-full ring-2 ring-sidebar",
              status.dotClass,
            )}
          />
        ) : null}
      </span>
      {/* The menu button truncates (and so clips) its last span; keeping the title last spares
          the icon wrapper, whose status dot sits outside its box. */}
      <span className="sr-only">{thread.title}</span>
    </RailButton>
  );
});

/**
 * The sidebar as an icon rail: navigation, the profile avatar, and one icon per pinned or
 * active thread in the current profile, marked with its status. Snoozed and settled threads
 * stay in the expanded sidebar.
 */
export function CollapsedThreadSidebar() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const activeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const activeThreadKey = activeThreadRef ? scopedThreadKey(activeThreadRef) : null;
  const threads = useThreadShells();
  const scopedProjectKeys = useProfileScopedProjectKeys();
  const { scope, profiles, projectProfiles } = useProfileScopeState();
  const colorByProfileId = useMemo(
    () => new Map(profiles.map((profile) => [profile.id, profile.color] as const)),
    [profiles],
  );
  // Snooze wakes are second-precise, so like the expanded sidebar the rail re-reads the clock
  // exactly when the earliest snooze ends rather than on a minute tick.
  const [now, setNow] = useState(() => new Date());
  const { pinned, active, nextWakeAtMs } = useMemo(
    () => partitionRailThreads({ threads, scopedProjectKeys, now }),
    [now, scopedProjectKeys, threads],
  );
  useEffect(() => {
    if (nextWakeAtMs === null) return;
    // setTimeout delays are signed 32-bit; clamp so a far-future wake re-arms instead of firing.
    const delayMs = Math.min(Math.max(0, nextWakeAtMs - Date.now()) + 50, 2_147_483_647);
    const id = window.setTimeout(() => setNow(new Date()), delayMs);
    return () => window.clearTimeout(id);
  }, [nextWakeAtMs]);

  const renderThreads = (list: ReadonlyArray<EnvironmentThreadShell>) =>
    list.map((thread) => {
      const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      const profileId =
        scope === "all"
          ? projectProfiles.get(projectScopeKey(thread.environmentId, thread.projectId))
          : null;
      return (
        <RailThreadButton
          key={key}
          thread={thread}
          isActive={key === activeThreadKey}
          profileColor={profileId ? (colorByProfileId.get(profileId) ?? null) : null}
        />
      );
    });

  return (
    <div className="flex h-full min-h-0 flex-col items-center">
      <div className="flex shrink-0 flex-col items-center gap-1 pt-2 pb-2">
        <ProfileSwitcher collapsed />
        <SidebarMenu className="items-center">
          <RailButton
            label="New thread"
            onClick={() => openCommandPalette({ open: "new-thread-in" })}
          >
            <SquarePenIcon />
          </RailButton>
          <RailButton label="Search" onClick={() => openCommandPalette()}>
            <SearchIcon />
          </RailButton>
          <RailButton
            label="Notes"
            isActive={pathname === "/notes"}
            onClick={() => void navigate({ to: "/notes" })}
          >
            <FileTextIcon />
          </RailButton>
          <RailButton
            label="Automations"
            isActive={pathname === "/automations"}
            onClick={() => void navigate({ to: "/automations" })}
          >
            <ZapIcon />
          </RailButton>
        </SidebarMenu>
      </div>
      <div aria-hidden className="h-px w-6 shrink-0 bg-sidebar-border" />
      <div className="min-h-0 w-full flex-1 overflow-y-auto overflow-x-hidden py-2 [scrollbar-width:none]">
        <SidebarMenu className="items-center">
          {renderThreads(pinned)}
          {pinned.length > 0 && active.length > 0 ? (
            <li aria-hidden className="my-1 h-px w-4 bg-sidebar-border" />
          ) : null}
          {renderThreads(active)}
        </SidebarMenu>
      </div>
      <SidebarMenu className="my-2 shrink-0 items-center">
        <RailButton
          label="Usage"
          isActive={pathname === "/usage"}
          onClick={() => void navigate({ to: "/usage" })}
        >
          <ChartNoAxesColumnIcon />
        </RailButton>
        <RailButton
          label="Settings"
          isActive={pathname.startsWith("/settings")}
          onClick={() => void navigate({ to: "/settings" })}
        >
          <SettingsIcon />
        </RailButton>
      </SidebarMenu>
    </div>
  );
}
