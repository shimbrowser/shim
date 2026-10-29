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

/**
 * Whether this build turns the vault on: secret settings with a declared
 * `use`, sealed in the vault and placed by the worker. On; the harnesses can
 * turn it off in one worker through its test flag (sw.ts), as a build that
 * must stop vault operations would ship it off (there is no remote switch).
 */
export const VAULT_ENABLED = true;

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
  // Declarative rules have no handler to call a member, but a settings
  // declaration is still served (its values are kept and the settings page
  // shows them), so the shim installs the same in either mode.
  apiMembers: Object.freeze(['settings'] as const),
  // A vault shim runs in a user-script world of its own, which declarative
  // mode never has: a secret field is refused here, never kept in the clear.
  secretSettings: 'none',
  componentIdentity: false,
  // Page inspection and trusted input arrive with the PageHost.
  engineInspection: false,
  trustedInput: false,
});

/**
 * Full mode: the user-script world, handlers compiled there. `script` and
 * `replace-root` run; `mount-route` needs the route registry the Shim
 * browser keeps in main, so it stays out. A handler gets the core members,
 * `api.storage`, and the host extras listed here: `api.settings` (values
 * from the settings page) and `api.fetch` (the worker's cookie-less broker).
 * Secret settings are refused here; EXTENSION_VAULT_CAPABILITIES takes them while the vault is on.
 */
export const EXTENSION_CAPABILITIES: PageHostCapabilities = Object.freeze({
  mutationKinds: Object.freeze([...DECLARATIVE_KINDS, 'script', 'replace-root']),
  iframeRules: false,
  specCss: true,
  apiMembers: Object.freeze(['settings', 'fetch'] as const),
  secretSettings: 'none',
  componentIdentity: false,
  engineInspection: false,
  trustedInput: false,
});

/**
 * Full mode with the vault on: a secret field that declares `use` installs;
 * its value is sealed in the vault and placed on a request by the worker,
 * and a handler reads only whether it is set. A vault shim needs its own
 * user-script world, so declarative mode never takes one.
 */
export const EXTENSION_VAULT_CAPABILITIES: PageHostCapabilities = Object.freeze({ ...EXTENSION_CAPABILITIES, secretSettings: 'declared' });

/**
 * What a session's PageHost (page-host.ts) can run: the engine in a world
 * the host creates over the DevTools protocol, where handler source
 * compiles whatever the page's CSP says and whatever the user-scripts
 * toggle says, so a session does not depend on the mode. Previews are per
 * rule, so nothing installs the spec-level stylesheet; trusted input is the
 * protocol's own. A preview's `api.settings` reads the installed shim's
 * values against the working declaration, and its `api.fetch` is the same
 * broker an installed shim uses. Each entry is advertised only while its
 * conformance case passes on this host.
 */
export const SESSION_CAPABILITIES: PageHostCapabilities = Object.freeze({
  mutationKinds: Object.freeze([...DECLARATIVE_KINDS, 'script', 'replace-root']),
  iframeRules: false,
  specCss: false,
  apiMembers: Object.freeze(['settings', 'fetch'] as const),
  secretSettings: 'none',
  componentIdentity: false,
  engineInspection: false,
  trustedInput: true,
});

/**
 * A session's capabilities with the vault on: a shim declaring a placed
 * secret can be previewed and committed. Its previews read every secret as
 * unset and a preview's fetch naming `secrets` is refused (the worker's
 * session handler api), and a session holding the tab suspends the
 * installed shim's secret use (credential-lease.ts), so no secret reaches a
 * session.
 */
export const SESSION_VAULT_CAPABILITIES: PageHostCapabilities = Object.freeze({ ...SESSION_CAPABILITIES, secretSettings: 'declared' });

export function sessionCapabilities(vault: boolean = VAULT_ENABLED): PageHostCapabilities {
  return vault ? SESSION_VAULT_CAPABILITIES : SESSION_CAPABILITIES;
}

/** What a never-throw api member this host lacks resolves with (D15). */
export const UNSUPPORTED_ERROR = 'not-available-in-shim-for-chrome';

export function capabilitiesFor(mode: ExtensionMode, vault: boolean = VAULT_ENABLED): PageHostCapabilities {
  if (mode !== 'full') return EXTENSION_DECLARATIVE_CAPABILITIES;
  return vault ? EXTENSION_VAULT_CAPABILITIES : EXTENSION_CAPABILITIES;
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
