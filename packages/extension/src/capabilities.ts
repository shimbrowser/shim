// The two capability contracts this host advertises, one per mode, and the
// mode in force. Every install and every session preflights against the
// one in force (capability-preflight, D15), so a shim that needs what this
// browser cannot run is refused up front with the reason, never silently
// different.
//
// Full mode: the engine runs in a user-script world that permits eval, so
// handler source compiles there and rules with handlers run. Declarative
// mode: the engine runs as an ordinary content script, nothing compiles, and
// only the declarative kinds run. A kind, member or feature enters a
// constant only with a passing conformance case on this host.

import type { PageHostCapabilities } from '@shimbrowser/core/page-host';

export type ExtensionMode = 'full' | 'declarative';

/** Mutation kinds whose rules carry handler source: they run in full mode only. */
export const HANDLER_KINDS: readonly string[] = Object.freeze(['script', 'replace-root', 'mount-route']);

const DECLARATIVE_KINDS: readonly string[] = Object.freeze([
  'hide', 'restyle', 'reorder', 'reshape', 'remove', 'inject-element', 'inject-html',
]);

/** Declarative mode: a content script, no compiled handlers. */
export const EXTENSION_DECLARATIVE_CAPABILITIES: PageHostCapabilities = Object.freeze({
  mutationKinds: DECLARATIVE_KINDS,
  // Content scripts register for the top frame only.
  iframeRules: false,
  // The whole committed spec runs through the engine, which installs its stylesheet.
  specCss: true,
  // Declarative rules have no handler, so no member is reachable.
  apiMembers: Object.freeze([]),
  componentIdentity: false,
  // Page inspection and trusted input arrive with the PageHost.
  engineInspection: false,
  trustedInput: false,
});

/** Full mode: the user-script world, handlers compiled there. Reachable once that world ships. */
export const EXTENSION_CAPABILITIES: PageHostCapabilities = Object.freeze({
  mutationKinds: Object.freeze([...DECLARATIVE_KINDS, 'script', 'replace-root']),
  iframeRules: false,
  specCss: true,
  apiMembers: Object.freeze([]),
  componentIdentity: false,
  engineInspection: false,
  trustedInput: false,
});

export function capabilitiesFor(mode: ExtensionMode): PageHostCapabilities {
  return mode === 'full' ? EXTENSION_CAPABILITIES : EXTENSION_DECLARATIVE_CAPABILITIES;
}

/**
 * The mode this browser runs in. Declarative for now: full mode needs the
 * user-script world, which this version does not register. When it does,
 * this reads whether `chrome.userScripts` is available and the user turned
 * it on for this extension.
 */
export function currentMode(): ExtensionMode {
  return 'declarative';
}

/** The one line an install refusal adds when the shim needs full mode. */
export const USER_SCRIPTS_REASON = 'rules with handlers (script, replace-root, mount-route) need user scripts, '
  + 'which this version of Shim for Chrome does not run yet; the shim runs in the Shim browser as it is';
