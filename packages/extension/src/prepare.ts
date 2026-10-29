// The install check, in a sandboxed extension page. An extension page's CSP
// permits no eval, so core's syntax probe (the handler-module check inside
// packShim) cannot run on the install page itself and would refuse every
// handler as unparseable. A sandboxed page (manifest "sandbox") has its own
// CSP that permits eval, no chrome.* API and an opaque origin; the install
// page embeds this one in a hidden frame and asks it over postMessage. Only
// the parent frame is answered, and only with what prepareInstall returns
// (plain data), so nothing of the sandbox reaches the worker but the
// prepared install the worker re-checks anyway.

import { prepareInstall, type PreparedInstall, type InstallRefusal } from './install';
import { capabilitiesFor, type ExtensionMode } from './capabilities';

export interface PrepareRequest {
  type: 'prepare';
  token: number;
  text: string;
  mode: ExtensionMode;
  /** The vault is on in the worker (its secret settings are kept sealed). */
  vault?: boolean;
}

export interface PrepareAnswer {
  type: 'prepared';
  token: number;
  result: PreparedInstall | InstallRefusal;
}

export const PREPARE_READY = 'prepare-ready';
/** The parent's own readiness probe: answered with PREPARE_READY, so a readiness lost before the parent listened is asked for again. */
export const PREPARE_PING = 'prepare-ping';

export function isPrepareRequest(msg: unknown): msg is PrepareRequest {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return m.type === 'prepare' && typeof m.token === 'number' && typeof m.text === 'string' && (m.mode === 'full' || m.mode === 'declarative');
}

export function isPrepareAnswer(msg: unknown): msg is PrepareAnswer {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return m.type === 'prepared' && typeof m.token === 'number' && typeof m.result === 'object' && m.result !== null;
}

if (typeof window !== 'undefined' && window.parent !== window) {
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (event.source !== window.parent) return;
    const data = event.data as { type?: unknown } | null;
    if (data?.type === PREPARE_PING) {
      window.parent.postMessage({ type: PREPARE_READY }, event.origin);
      return;
    }
    if (!isPrepareRequest(event.data)) return;
    const { token, text, mode, vault } = event.data;
    const result = prepareInstall(text, capabilitiesFor(mode, vault === true), mode);
    const answer: PrepareAnswer = { type: 'prepared', token, result };
    window.parent.postMessage(answer, event.origin);
  });
  // Unsolicited once, in case the parent already listens; the parent pings
  // otherwise (its script may load after this frame ran).
  window.parent.postMessage({ type: PREPARE_READY }, '*');
}
