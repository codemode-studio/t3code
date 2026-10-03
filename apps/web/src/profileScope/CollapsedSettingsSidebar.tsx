import { ArrowLeftIcon } from "lucide-react";

import { useNavigateToMainApp } from "../components/sidebar/mainAppLocation";
import { useSettingsSections } from "../components/settings/SettingsSidebarNav";
import { SidebarMenu } from "../components/ui/sidebar";
import { RailButton } from "./CollapsedThreadSidebar";

/**
 * The settings sidebar as an icon rail: one icon per section, and Back to the app. Search stays
 * in the expanded sidebar; `/` expands it and focuses the field.
 */
export function CollapsedSettingsSidebar({ pathname }: { pathname: string }) {
  const { navItems, isSectionActive, openSection } = useSettingsSections(pathname);
  const navigateToMainApp = useNavigateToMainApp();
  return (
    <div className="flex h-full min-h-0 flex-col items-center">
      <div className="min-h-0 w-full flex-1 overflow-y-auto overflow-x-hidden py-2 [scrollbar-width:none]">
        <SidebarMenu className="items-center">
          {navItems.map(({ to, label, icon: Icon }) => (
            <RailButton
              key={to}
              label={label}
              isActive={isSectionActive(to)}
              onClick={() => openSection(to)}
            >
              <Icon />
            </RailButton>
          ))}
        </SidebarMenu>
      </div>
      <SidebarMenu className="my-2 shrink-0 items-center">
        <RailButton label="Back" onClick={() => void navigateToMainApp()}>
          <ArrowLeftIcon />
        </RailButton>
      </SidebarMenu>
    </div>
  );
}
