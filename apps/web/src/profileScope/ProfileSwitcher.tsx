import { useAtomValue } from "@effect/atom-react";
import { PROFILE_SCOPE_KEYBINDING_COMMANDS } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronsUpDownIcon, LayersIcon, PlusIcon } from "lucide-react";
import { useEffect } from "react";

import { Badge } from "../components/ui/badge";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "../components/ui/menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { cn } from "../lib/utils";
import { primaryServerKeybindingsAtom } from "../state/server";
import {
  profileMonogram,
  type ProfileScope,
  type ProfileScopeProfile,
} from "@t3tools/client-runtime/state/profile-scope";
import { useProfileAttentionCounts, useProfileScopeState } from "./useProfileScope";

interface ScopeOption {
  readonly scope: ProfileScope;
  readonly label: string;
  readonly profile: ProfileScopeProfile | null;
  readonly attention: number;
}

/**
 * The profile's color square with its initials. "All profiles" is a plain icon, like the nav rows
 * beside it. The small square overhangs its 16px icon slot by 2px per side, so its center lines up
 * with the icons of neighboring rows.
 */
export function ProfileAvatar({
  option,
  size,
}: {
  option: Pick<ScopeOption, "scope" | "profile" | "label">;
  size: "sm" | "md";
}) {
  const boxClass =
    size === "sm" ? "-mx-0.5 size-5 rounded-sm text-3xs" : "size-7 rounded-md text-xs";
  if (option.profile) {
    return (
      <span
        aria-hidden
        className={cn("grid shrink-0 place-items-center font-semibold text-white", boxClass)}
        style={{ backgroundColor: option.profile.color ?? "var(--color-muted-foreground)" }}
      >
        {profileMonogram(option.profile.name)}
      </span>
    );
  }
  if (option.scope === "unassigned") {
    return (
      <span
        aria-hidden
        className={cn(
          "grid shrink-0 place-items-center border border-dashed border-muted-foreground/50 text-muted-foreground",
          boxClass,
        )}
      >
        ?
      </span>
    );
  }
  return <LayersIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />;
}

function useScopeOptions() {
  const state = useProfileScopeState();
  const attention = useProfileAttentionCounts(state.projectProfiles);
  const options: ScopeOption[] = [
    { scope: "all", label: "All profiles", profile: null, attention: 0 },
    ...state.profiles.map((profile) => ({
      scope: profile.id,
      label: profile.name,
      profile,
      attention: attention.get(profile.id) ?? 0,
    })),
    ...(state.hasUnassignedProjects
      ? [
          {
            scope: "unassigned" as const,
            label: "Unassigned",
            profile: null,
            attention: attention.get(null) ?? 0,
          },
        ]
      : []),
  ];
  const current = options.find((option) => option.scope === state.scope) ?? options[0]!;
  // What the user is missing while looking at one profile: work waiting in the others.
  const attentionElsewhere =
    state.scope === "all"
      ? 0
      : options.reduce(
          (total, option) => (option.scope === state.scope ? total : total + option.attention),
          0,
        );
  return { ...state, options, current, attentionElsewhere };
}

/** Runs the `profile.*` keybindings: index 0 shows every profile, 1-9 pick one in menu order. */
export function ProfileScopeShortcuts() {
  const { options, setScope, profiles } = useScopeOptions();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  useEffect(() => {
    if (profiles.length === 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings);
      const index =
        command === null ? -1 : PROFILE_SCOPE_KEYBINDING_COMMANDS.indexOf(command as never);
      const option = options[index];
      if (!option) return;
      event.preventDefault();
      setScope(option.scope);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, options, profiles.length, setScope]);
  return null;
}

function ScopeShortcut({ index }: { index: number }) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const label = shortcutLabelForCommand(
    keybindings,
    PROFILE_SCOPE_KEYBINDING_COMMANDS[index] ?? null,
  );
  return label ? <MenuShortcut>{label}</MenuShortcut> : null;
}

function AttentionCount({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <Badge variant="warning" size="sm" aria-label={`${count} waiting on you`}>
      {count}
    </Badge>
  );
}

function ProfileScopeMenuPopup({
  options,
  current,
  onSelect,
  side,
}: {
  options: ReadonlyArray<ScopeOption>;
  current: ScopeOption;
  onSelect: (scope: ProfileScope) => void;
  side: "bottom" | "right";
}) {
  const navigate = useNavigate();
  return (
    <MenuPopup align="start" side={side} sideOffset={side === "right" ? 8 : 4} className="w-64">
      <MenuGroup>
        <MenuGroupLabel>Profiles</MenuGroupLabel>
        <MenuRadioGroup
          value={current.scope}
          onValueChange={(value: ProfileScope) => onSelect(value)}
        >
          {options.map((option, index) => (
            <MenuRadioItem key={option.scope} value={option.scope}>
              <span className="flex items-center gap-2">
                <ProfileAvatar option={option} size="sm" />
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                <AttentionCount count={option.attention} />
                <ScopeShortcut index={index} />
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuGroup>
      <MenuSeparator />
      <MenuItem onClick={() => void navigate({ to: "/settings/providers" })}>
        <PlusIcon />
        <span>Add profile</span>
      </MenuItem>
    </MenuPopup>
  );
}

/** Picks the company the sidebar shows: a row above the thread list. */
export function ProfileSwitcher() {
  const { options, current, setScope, profiles, attentionElsewhere } = useScopeOptions();
  if (profiles.length === 0) return null;
  const elsewhereLabel =
    attentionElsewhere > 0 ? `${attentionElsewhere} waiting in other profiles` : null;

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <Menu>
            <MenuTrigger render={<SidebarMenuButton aria-label={`Profile: ${current.label}`} />}>
              <ProfileAvatar option={current} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-sidebar-foreground">
                {current.label}
              </span>
              {elsewhereLabel ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        aria-label={elsewhereLabel}
                        className="size-2 shrink-0 rounded-full bg-warning"
                      />
                    }
                  />
                  <TooltipPopup side="bottom">{elsewhereLabel}</TooltipPopup>
                </Tooltip>
              ) : null}
              <ChevronsUpDownIcon className="size-4 shrink-0 text-muted-foreground" />
            </MenuTrigger>
            <ProfileScopeMenuPopup
              options={options}
              current={current}
              onSelect={setScope}
              side="bottom"
            />
          </Menu>
        </SidebarMenuItem>
      </SidebarMenu>
      {/* Separates what the profile scopes (below) from the control that picks it. */}
      <div aria-hidden className="mx-2.5 my-1.5 h-px bg-sidebar-border" />
    </>
  );
}
