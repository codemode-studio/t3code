import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { useResizableWidth } from "~/hooks/useResizableWidth";
import { cn } from "~/lib/utils";
import { PanelResizeHandle } from "./PanelResizeHandle";

const LIST_PANE_DEFAULT_WIDTH = 18 * 16;
const LIST_PANE_MIN_WIDTH = 13 * 16;
const LIST_PANE_MAX_WIDTH = 32 * 16;
/** Width kept free for the editor beside the pane so its controls never overflow. */
const EDITOR_MIN_WIDTH = 360;

export function getWorkspaceListPaneMaxWidth(rowWidth?: number): number {
  const rowCap = rowWidth === undefined ? Infinity : Math.floor(rowWidth) - EDITOR_MIN_WIDTH;
  // Never below the pane's minimum: when the row cannot fit both, the editor
  // yields, and the width hook must not see max < min.
  return Math.max(LIST_PANE_MIN_WIDTH, Math.min(LIST_PANE_MAX_WIDTH, rowCap));
}

/**
 * The resizable list column on the left of a workspace page (Notes,
 * Automations). Its width persists per page under `storageKey` and is clamped
 * to the row it shares with the editor, so narrowing the window or opening the
 * app sidebar never squeezes the editor below a usable width.
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
  const paneRef = useRef<HTMLElement | null>(null);
  const [rowWidth, setRowWidth] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const row = paneRef.current?.parentElement;
    if (!row) return;
    // Measure before first paint so a restored wide pane never flashes over the editor.
    const measure = () => setRowWidth(row.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, []);
  const { width, handlers } = useResizableWidth({
    storageKey,
    defaultWidth: LIST_PANE_DEFAULT_WIDTH,
    minWidth: LIST_PANE_MIN_WIDTH,
    maxWidth: getWorkspaceListPaneMaxWidth(rowWidth),
    edge: "right",
  });
  return (
    <aside
      ref={paneRef}
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
