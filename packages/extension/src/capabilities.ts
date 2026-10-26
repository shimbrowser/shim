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

/**
 * Full mode: the user-script world, handlers compiled there. `script` and
 * `replace-root` run; `mount-route` needs the route registry the Shim
 * browser keeps in main, so it stays out. The members a handler can use
 * are the core ones plus `api.storage`, the same as declarative mode's
 * engine gives: `apiMembers` lists the host-provided extras, and this host
 * provides none yet (`fetch` and `settings` are a later phase).
 */
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
 * The user-scripts API as the mode probe sees it: present or not, and a
 * cheap call on it that succeeds only while the user allows user scripts.
 */
export interface UserScriptsProbe {
  userScripts?: { getScripts?: (filter?: { ids?: string[] }) => Promise<unknown> } | undefined;
}

/**
 * Is `chrome.userScripts` usable here? Presence is not enough: after a
 * fresh load with user scripts disallowed the property is absent (or the
 * read throws), but while the user flips the toggle under a running
 * extension (no reload) the object stays and every call on it throws
 * "not available in this context". So the mode is a call, not a read: the
 * cheapest one, a filtered getScripts for no ids.
 */
export async function userScriptsAvailable(api: UserScriptsProbe | undefined = globalThis.chrome as UserScriptsProbe | undefined): Promise<boolean> {
  try {
    const userScripts = api?.userScripts;
    if (!userScripts || typeof userScripts.getScripts !== 'function') return false;
    await userScripts.getScripts({ ids: [] });
    return true;
  } catch {
    return false;
  }
}

/**
 * The mode this browser runs in right now: full while user scripts are
 * allowed, declarative otherwise. The toggle fires no event and reloads
 * nothing, so the worker asks again on every navigation and message and
 * reconciles when the answer changes.
 */
export async function detectMode(api?: UserScriptsProbe | undefined): Promise<ExtensionMode> {
  return (await userScriptsAvailable(api)) ? 'full' : 'declarative';
}

/** How a user turns full mode on, for the popup and for a refusal. */
export const HOW_TO_ENABLE = 'turn on "Allow user scripts" for Shim for Chrome on chrome://extensions '
  + '(Chrome 138 and later; before that, turn on developer mode there)';

/** The one line an install refusal adds when the shim needs full mode. */
export const USER_SCRIPTS_REASON = 'rules with handlers (script, replace-root) need user scripts: '
  + `${HOW_TO_ENABLE}, then install the shim again`;
