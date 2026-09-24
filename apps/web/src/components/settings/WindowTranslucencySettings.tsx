import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_WINDOW_TRANSLUCENCY_BLUR,
  MAX_WINDOW_TRANSLUCENCY_OPACITY,
  MIN_WINDOW_TRANSLUCENCY_BLUR,
  MIN_WINDOW_TRANSLUCENCY_OPACITY,
} from "@t3tools/contracts/settings";
import type { CSSProperties } from "react";

import { isMacPlatform, isWindowsPlatform } from "../../lib/utils";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

function translucencyDescription(platform: string): string {
  if (isMacPlatform(platform)) {
    return "Show a blurred view of the desktop behind T3 Code. Turning this on or off applies after restarting T3 Code.";
  }
  if (isWindowsPlatform(platform)) {
    return "Show a blurred view of the desktop behind T3 Code. Requires Windows 11.";
  }
  return "Let the desktop show through T3 Code. Your compositor controls the blur. Turning this on or off applies after restarting T3 Code.";
}

function sliderStyle(value: number, min: number, max: number): CSSProperties {
  const ratio = (value - min) / (max - min);
  return {
    "--settings-slider-progress": `${ratio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
  } as CSSProperties;
}

// Desktop-only: the desktop app owns the native window material behind these.
export function WindowTranslucencySection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const platform = navigator.platform;

  return (
    <SettingsSection id="appearance-translucency" title="Translucency">
      <SettingsRow
        {...searchableSetting("window-translucency")}
        description={translucencyDescription(platform)}
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
                  style={sliderStyle(
                    settings.windowTranslucencyOpacity,
                    MIN_WINDOW_TRANSLUCENCY_OPACITY,
                    MAX_WINDOW_TRANSLUCENCY_OPACITY,
                  )}
                  type="range"
                  value={settings.windowTranslucencyOpacity}
                />
              </div>
            }
          />

          {isMacPlatform(platform) ? (
            <SettingsRow
              {...searchableSetting("setting-window-translucency-blur")}
              description="How much the desktop behind the window is blurred."
              resetAction={
                settings.windowTranslucencyBlur !==
                DEFAULT_UNIFIED_SETTINGS.windowTranslucencyBlur ? (
                  <SettingResetButton
                    label="blur radius"
                    onClick={() =>
                      updateSettings({
                        windowTranslucencyBlur: DEFAULT_UNIFIED_SETTINGS.windowTranslucencyBlur,
                      })
                    }
                  />
                ) : null
              }
              control={
                <div className="flex w-full items-center gap-3 sm:w-52">
                  <output
                    className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                    htmlFor="window-translucency-blur"
                  >
                    {settings.windowTranslucencyBlur}
                  </output>
                  <input
                    aria-label="Blur radius"
                    className="settings-slider min-w-0 flex-1"
                    id="window-translucency-blur"
                    max={MAX_WINDOW_TRANSLUCENCY_BLUR}
                    min={MIN_WINDOW_TRANSLUCENCY_BLUR}
                    onChange={(event) => {
                      const windowTranslucencyBlur = Number(event.currentTarget.value);
                      if (
                        Number.isInteger(windowTranslucencyBlur) &&
                        windowTranslucencyBlur >= MIN_WINDOW_TRANSLUCENCY_BLUR &&
                        windowTranslucencyBlur <= MAX_WINDOW_TRANSLUCENCY_BLUR
                      ) {
                        updateSettings({ windowTranslucencyBlur });
                      }
                    }}
                    step={1}
                    style={sliderStyle(
                      settings.windowTranslucencyBlur,
                      MIN_WINDOW_TRANSLUCENCY_BLUR,
                      MAX_WINDOW_TRANSLUCENCY_BLUR,
                    )}
                    type="range"
                    value={settings.windowTranslucencyBlur}
                  />
                </div>
              }
            />
          ) : null}

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
