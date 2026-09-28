import type { ReactNode } from "react";

/**
 * Shows the rail while collapsed without unmounting the expanded sidebar. Thread jump and
 * previous/next shortcuts live in the expanded sidebars (`Sidebar`, `LegacySidebar`), so they
 * keep working collapsed, as they did when collapsing only slid the sidebar off-canvas.
 * `display: contents` keeps the expanded content a direct flex child of the sidebar.
 */
export function SidebarContentSlot({
  showRail,
  rail,
  children,
}: {
  showRail: boolean;
  rail: ReactNode;
  children?: ReactNode;
}) {
  return (
    <>
      <div className={showRail ? "hidden" : "contents"} data-sidebar-expanded-content="">
        {children}
      </div>
      {showRail ? rail : null}
    </>
  );
}
