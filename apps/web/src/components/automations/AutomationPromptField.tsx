/**
 * The automation instructions field: a plain textarea with the composer's "@" file and "$" skill
 * pickers. The text is stored and sent as-is, so it inserts the same tokens the composer sends.
 * Composer-only slash commands (/model, /plan) are left out: a server-started run cannot act on them.
 */
import type { EnvironmentId, ProviderDriverKind, ServerProvider } from "@t3tools/contracts";
import {
  formatProviderSkillDisplayName,
  resolveProviderSkillsForCwd,
} from "@t3tools/client-runtime/providerSkills";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { type KeyboardEvent, useRef, useState } from "react";

import {
  type ComposerTrigger,
  detectComposerTrigger,
  replaceTextRange,
} from "../../composer-logic";
import { useTheme } from "../../hooks/useTheme";
import { useComposerPathSearch } from "../../lib/composerPathSearchState";
import { basenameOfPath } from "../../pierre-icons";
import { searchProviderSkills } from "../../providerSkillSearch";
import { type ComposerCommandItem, ComposerCommandMenu } from "../chat/ComposerCommandMenu";
import { Textarea } from "../ui/textarea";

/** A readable `@path` where the path allows it; the composer's link form where it has spaces. */
function fileReference(path: string): string {
  return /\s/.test(path) ? serializeComposerFileLink(path) : `@${path}`;
}

export function AutomationPromptField({
  value,
  onChange,
  environmentId,
  cwd,
  provider,
  providerKind,
}: {
  value: string;
  onChange: (value: string) => void;
  environmentId: EnvironmentId | null;
  /** The project's checkout, for file search and project-scoped skills. */
  cwd: string | null;
  /** The selected model's provider, whose skills "$" offers. */
  provider: ServerProvider | null;
  providerKind: ProviderDriverKind | null;
}) {
  const { resolvedTheme } = useTheme();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState(value.length);
  const [focused, setFocused] = useState(false);
  // Escape closes the menu for the token at this position until the caret leaves it.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const detected = detectComposerTrigger(value, cursor);
  const trigger: ComposerTrigger | null =
    detected && (detected.kind === "path" || detected.kind === "skill") ? detected : null;

  const pathSearch = useComposerPathSearch({
    environmentId,
    cwd: trigger?.kind === "path" ? cwd : null,
    query: trigger?.kind === "path" ? trigger.query : null,
  });
  const skills = provider ? resolveProviderSkillsForCwd(provider, cwd) : [];

  const items = ((): ComposerCommandItem[] => {
    if (trigger?.kind === "path") {
      return pathSearch.entries.map((entry) => ({
        id: `path:${entry.kind}:${entry.path}`,
        type: "path",
        path: entry.path,
        pathKind: entry.kind,
        label: basenameOfPath(entry.path),
        description: entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))),
      }));
    }
    if (trigger?.kind === "skill" && providerKind) {
      return searchProviderSkills(skills, trigger.query).map((skill) => ({
        id: `skill:${providerKind}:${skill.name}`,
        type: "skill",
        provider: providerKind,
        skill,
        label: formatProviderSkillDisplayName(skill),
        description:
          skill.shortDescription ??
          skill.description ??
          (skill.scope ? `${skill.scope} skill` : "Run provider skill"),
      }));
    }
    return [];
  })();

  const activeId =
    highlightedId && items.some((item) => item.id === highlightedId)
      ? highlightedId
      : (items[0]?.id ?? null);

  const moveCursor = (text: string, next: number) => {
    setCursor(next);
    // Leaving the dismissed token lets the next one open the menu again.
    if (dismissedAt !== null && detectComposerTrigger(text, next)?.rangeStart !== dismissedAt) {
      setDismissedAt(null);
    }
  };

  const select = (item: ComposerCommandItem) => {
    if (!trigger) return;
    const replacement =
      item.type === "path"
        ? `${fileReference(item.path)} `
        : item.type === "skill"
          ? `$${item.skill.name} `
          : null;
    if (replacement === null) return;
    const next = replaceTextRange(value, trigger.rangeStart, trigger.rangeEnd, replacement);
    onChange(next.text);
    setCursor(next.cursor);
    setHighlightedId(null);
    // Put the caret after the inserted token once React has written the new value.
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(next.cursor, next.cursor);
    });
  };

  const menuOpen =
    focused &&
    trigger !== null &&
    trigger.rangeStart !== dismissedAt &&
    (items.length > 0 ||
      trigger.kind === "path" ||
      (trigger.kind === "skill" && provider !== null));

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!menuOpen || !trigger) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissedAt(trigger.rangeStart);
      return;
    }
    if (items.length === 0) return;
    const index = Math.max(
      0,
      items.findIndex((item) => item.id === activeId),
    );
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      setHighlightedId(items[(index + offset + items.length) % items.length]?.id ?? null);
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      const item = items[index];
      if (!item) return;
      event.preventDefault();
      select(item);
    }
  };

  return (
    <div className="relative">
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          moveCursor(event.target.value, event.target.selectionStart);
        }}
        onSelect={(event) => moveCursor(value, event.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder="Tell the agent what to do when this automation runs…"
        aria-label="Instructions"
        aria-expanded={menuOpen}
        aria-autocomplete="list"
        rows={8}
      />
      {menuOpen ? (
        <div className="absolute inset-x-0 top-full z-50 mt-1 overflow-hidden rounded-lg border bg-popover shadow-lg">
          <ComposerCommandMenu
            items={items}
            resolvedTheme={resolvedTheme}
            isLoading={trigger.kind === "path" && pathSearch.isPending}
            triggerKind={trigger.kind}
            {...(trigger.kind === "skill"
              ? { emptyStateText: "No skills found for this model's provider." }
              : cwd === null
                ? { emptyStateText: "Choose a project to reference its files." }
                : {})}
            activeItemId={activeId}
            onHighlightedItemChange={setHighlightedId}
            onSelect={select}
          />
        </div>
      ) : null}
    </div>
  );
}
