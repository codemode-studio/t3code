let canShow: boolean | undefined;

// Whether this desktop window can show translucency. macOS and Linux fix it
// when the window is created, so it holds for the page's lifetime. Desktop
// builds without the bridge method keep the old always-on behavior.
export function canShowWindowTranslucency(): boolean {
  canShow ??= window.desktopBridge?.canShowWindowTranslucency?.() ?? true;
  return canShow;
}
