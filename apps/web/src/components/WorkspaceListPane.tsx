import type { CSSProperties, ReactNode } from "react";

import { useResizableWidth } from "~/hooks/useResizableWidth";
import { cn } from "~/lib/utils";
import { PanelResizeHandle } from "./PanelResizeHandle";

const LIST_PANE_DEFAULT_WIDTH = 18 * 16;
const LIST_PANE_MIN_WIDTH = 13 * 16;
const LIST_PANE_MAX_WIDTH = 32 * 16;

/**
 * The resizable list column on the left of a workspace page (Notes,
 * Automations). Its width persists per page under `storageKey`.
 */
export function WorkspaceListPane({
  storageKey,
  className,
  children,
}: {
  readonly storageKey: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const { width, handlers } = useResizableWidth({
    storageKey,
    defaultWidth: LIST_PANE_DEFAULT_WIDTH,
    minWidth: LIST_PANE_MIN_WIDTH,
    maxWidth: LIST_PANE_MAX_WIDTH,
    edge: "right",
  });
  return (
    <aside
      style={{ "--list-pane-width": `${width}px` } as CSSProperties}
      className={cn(
        "relative flex w-(--list-pane-width) shrink-0 flex-col border-r border-pane-edge",
        className,
      )}
    >
      {children}
      <PanelResizeHandle handlers={handlers} edge="right" className="max-sm:hidden" />
    </aside>
  );
}
