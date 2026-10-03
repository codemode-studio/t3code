declare const __T3CODE_BUILD_RELEASE_BASE_URL__: string | undefined;

/**
 * Fork: the releases this build came from, baked in by fork-release.yml. Updates and staged
 * runtimes then come from the fork even when a client (such as the upstream mobile app) asks for
 * a version, instead of installing an upstream build over it.
 */
const buildTimeReleaseBaseUrl =
  typeof __T3CODE_BUILD_RELEASE_BASE_URL__ === "undefined"
    ? ""
    : __T3CODE_BUILD_RELEASE_BASE_URL__.trim();

/** `T3CODE_RELEASE_BASE_URL` wins, then the build's own releases, then upstream's default. */
export function resolveReleaseBaseUrl(override: string | undefined): string | undefined {
  return override?.trim() || buildTimeReleaseBaseUrl || undefined;
}
