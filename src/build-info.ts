export interface BuildInfo {
  readonly name: string;
  readonly version: string;
  /** Full 40-hex source commit captured by build.mjs. */
  readonly sha: string;
  /** True when tracked or untracked source changes were present at build time. */
  readonly dirty: boolean;
}

declare const __MESSENGER_BUILD_INFO__: BuildInfo | undefined;

// Source-mode tests import TypeScript directly, outside esbuild's define pass.
// Shipped artifacts always replace this reference with build-time metadata.
export const BUILD_INFO: BuildInfo = Object.freeze(
  typeof __MESSENGER_BUILD_INFO__ === 'undefined'
    ? {
        name: '@ours.network/messenger-server',
        version: '0.1.0',
        sha: '0000000000000000000000000000000000000000',
        dirty: true,
      }
    : __MESSENGER_BUILD_INFO__,
);
