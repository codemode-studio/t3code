import type * as Electron from "electron";

// macOS has no public API for blurring the desktop behind a transparent window.
// Vibrancy materials blur too, but paint their own tint over it, which makes
// low opacities look grey. This calls the private WindowServer function that
// MonoCode and other translucent apps use, so the only tint is the app's own.

type SetBlurRadius = (windowNumber: number, radius: number) => void;

let setBlurRadiusPromise: Promise<SetBlurRadius> | undefined;

function loadSetBlurRadius(): Promise<SetBlurRadius> {
  setBlurRadiusPromise ??= import("ffi-rs").then(({ DataType, load, open }) => {
    const coreGraphics = "t3-core-graphics";
    open({
      library: coreGraphics,
      path: "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics",
    });
    const connection = load({
      library: coreGraphics,
      funcName: "CGSMainConnectionID",
      retType: DataType.I32,
      paramsType: [],
      paramsValue: [],
    });
    return (windowNumber, radius) => {
      load({
        library: coreGraphics,
        funcName: "CGSSetWindowBackgroundBlurRadius",
        retType: DataType.I32,
        paramsType: [DataType.I32, DataType.I32, DataType.I32],
        paramsValue: [connection, windowNumber, radius],
      });
    };
  });
  return setBlurRadiusPromise;
}

// The media source id is `window:<CGWindowID>:0`, and the CGWindowID is the
// NSWindow's window number.
export function parseMacWindowNumber(mediaSourceId: string): number | null {
  const match = /^window:(\d+):/.exec(mediaSourceId);
  const windowNumber = match ? Number(match[1]) : 0;
  return windowNumber > 0 ? windowNumber : null;
}

export async function setMacWindowBlurRadius(
  window: Electron.BrowserWindow,
  radius: number,
): Promise<void> {
  if (window.isDestroyed()) return;
  const windowNumber = parseMacWindowNumber(window.getMediaSourceId());
  if (windowNumber === null) return;
  const setBlurRadius = await loadSetBlurRadius();
  if (window.isDestroyed()) return;
  setBlurRadius(windowNumber, radius);
}
