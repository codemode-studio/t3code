import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_WINDOW_TRANSLUCENCY_OPACITY,
  MIN_WINDOW_TRANSLUCENCY_OPACITY,
} from "@t3tools/contracts/settings";
import type { CSSProperties } from "react";

import { isMacPlatform, isWindowsPlatform } from "../../lib/utils";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

function translucencyDescription(platform: string): string {
  if (isMacPlatform(platform)) return "Show a blurred view of the desktop behind T3 Code.";
  if (isWindowsPlatform(platform)) {
    return "Show a blurred view of the desktop behind T3 Code. Requires Windows 11.";
  }
  return "Let the desktop show through T3 Code. Your compositor controls the blur. Applies after restarting T3 Code.";
}

// Desktop-only: the desktop app owns the native window material behind these.
export function WindowTranslucencySection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const opacityRatio =
    (settings.windowTranslucencyOpacity - MIN_WINDOW_TRANSLUCENCY_OPACITY) /
    (MAX_WINDOW_TRANSLUCENCY_OPACITY - MIN_WINDOW_TRANSLUCENCY_OPACITY);
  const opacitySliderStyle = {
    "--settings-slider-progress": `${opacityRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - opacityRatio}rem`,
  } as CSSProperties;

  return (
    <SettingsSection id="appearance-translucency" title="Translucency">
      <SettingsRow
        {...searchableSetting("window-translucency")}
        description={translucencyDescription(navigator.platform)}
        resetAction={
          settings.windowTranslucency !== DEFAULT_UNIFIED_SETTINGS.windowTranslucency ? (
            <SettingResetButton
              label="window translucency"
              onClick={() =>
                updateSettings({ windowTranslucency: DEFAULT_UNIFIED_SETTINGS.windowTranslucency })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.windowTranslucency}
            onCheckedChange={(checked) => updateSettings({ windowTranslucency: Boolean(checked) })}
            aria-label="Window translucency"
          />
        }
      />

      {settings.windowTranslucency ? (
        <>
          <SettingsRow
            {...searchableSetting("setting-window-translucency-opacity")}
            description="How solid the sidebar is. Lower values show more of the desktop."
            resetAction={
              settings.windowTranslucencyOpacity !==
              DEFAULT_UNIFIED_SETTINGS.windowTranslucencyOpacity ? (
                <SettingResetButton
                  label="sidebar opacity"
                  onClick={() =>
                    updateSettings({
                      windowTranslucencyOpacity: DEFAULT_UNIFIED_SETTINGS.windowTranslucencyOpacity,
                    })
                  }
                />
              ) : null
            }
            control={
              <div className="flex w-full items-center gap-3 sm:w-52">
                <output
                  className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                  htmlFor="window-translucency-opacity"
                >
                  {settings.windowTranslucencyOpacity}%
                </output>
                <input
                  aria-label="Sidebar opacity"
                  className="settings-slider min-w-0 flex-1"
                  id="window-translucency-opacity"
                  max={MAX_WINDOW_TRANSLUCENCY_OPACITY}
                  min={MIN_WINDOW_TRANSLUCENCY_OPACITY}
                  onChange={(event) => {
                    const windowTranslucencyOpacity = Number(event.currentTarget.value);
                    if (
                      Number.isInteger(windowTranslucencyOpacity) &&
                      windowTranslucencyOpacity >= MIN_WINDOW_TRANSLUCENCY_OPACITY &&
                      windowTranslucencyOpacity <= MAX_WINDOW_TRANSLUCENCY_OPACITY
                    ) {
                      updateSettings({ windowTranslucencyOpacity });
                    }
                  }}
                  step={5}
                  style={opacitySliderStyle}
                  type="range"
                  value={settings.windowTranslucencyOpacity}
                />
              </div>
            }
          />

          <SettingsRow
            {...searchableSetting("window-translucency-main-pane")}
            description="Extend the translucency to the main pane behind threads and settings."
            resetAction={
              settings.windowTranslucencyMainPane !==
              DEFAULT_UNIFIED_SETTINGS.windowTranslucencyMainPane ? (
                <SettingResetButton
                  label="main pane glass"
                  onClick={() =>
                    updateSettings({
                      windowTranslucencyMainPane:
                        DEFAULT_UNIFIED_SETTINGS.windowTranslucencyMainPane,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.windowTranslucencyMainPane}
                onCheckedChange={(checked) =>
                  updateSettings({ windowTranslucencyMainPane: Boolean(checked) })
                }
                aria-label="Main pane glass"
              />
            }
          />
        </>
      ) : null}
    </SettingsSection>
  );
}
