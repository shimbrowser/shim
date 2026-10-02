// The composition-only session tools (shim-core design D2, D3, D16, §5): what
// @shimbrowser/mcp registers statically, beside the page and API map tools,
// for an agent driving a composition session. ONE definition per tool, here.
//
//   probe_request  one GET of the agent's own through the composition's real
//                  fetch path (grants, mint, same-host redirects) — §5's API
//                  map group, composition sessions only
//   read_calls     the composition's broker call trace: the requests its
//                  page made, identity and status only — §5's data group
//
// A shim session answers both as not offered. Also here: the answer and the
// note a composition session gives when its page calls api.ai (D16 — an
// external session never spends the user's key, invariant 4).
//
// Pure data, like page-tools.ts.

import type { ToolDefinition } from './page-tools';

export const COMPOSITION_SESSION_TOOL_NAMES = ['probe_request', 'read_calls'] as const;
export type CompositionSessionToolName = (typeof COMPOSITION_SESSION_TOOL_NAMES)[number];

export function isCompositionSessionToolName(name: string): name is CompositionSessionToolName {
  return (COMPOSITION_SESSION_TOOL_NAMES as readonly string[]).includes(name);
}

/** read_calls answers at most this many calls. */
export const MAX_READ_CALLS = 200;
/** read_calls' default `limit`. */
export const DEFAULT_READ_CALLS = 50;

/** What an api.ai call resolves to while an external session holds the composition. */
export const AI_UNAVAILABLE_IN_EXTERNAL_SESSION = 'ai-unavailable-in-external-session';

/**
 * What the agent tells the user, once per session, the first time the page
 * calls api.ai (D16).
 */
export const AI_UNAVAILABLE_USER_MESSAGE =
  "Shim can't use your Claude Code subscription, so AI features in this page won't run while Claude Code " +
  'builds it. Open the composition in Shim (with an API key set) to see them work.';

export const SESSION_COMPOSITION_TOOLS: Record<CompositionSessionToolName, ToolDefinition> = {
  probe_request: {
    name: 'probe_request',
    description:
      'Composition sessions only. Make one GET yourself through the composition\'s real fetch path (its ' +
      'grants, mint and same-host redirects) to a host its manifest declares and the user granted — for a URL ' +
      'Discovery never captured: the page or script a key is embedded in (to design a mint), or an endpoint\'s ' +
      'live response shape. Returns the status and up to 20,000 characters of the body; nothing is stored. A ' +
      'probe is your request, not the page\'s: it never shows up in read_calls and is no evidence the page ' +
      'works. A host the manifest does not declare yet must be added to manifest.json and previewed first ' +
      '(the user is asked in Shim to allow a new host).',
    input_schema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'A host the manifest declares, e.g. "api.example.com".' },
        path: { type: 'string', description: 'The path and optional query, starting with "/".' },
      },
      required: ['host', 'path'],
    },
  },
  read_calls: {
    name: 'read_calls',
    description:
      'Composition sessions only. The requests the composition\'s page made through window.api.fetch since ' +
      'the session started: per call the method, host, path template (and GraphQL / JSON-RPC operation), the ' +
      'status and whether it succeeded — never a request or response body. By default only calls made by ' +
      'documents running the current code (loaded after your latest preview); pass all for every call. A call ' +
      'Shim refused before any request (a host not granted, a write while you build) is not listed: the page ' +
      'got { ok: false, error } for it. This is the evidence that a data feature works: after a preview (or ' +
      'an interact_page), the call you expect should be here with a 2xx status.',
    input_schema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: 'Include calls from documents that ran earlier code. Default false.' },
        limit: { type: 'number', description: `Most calls to return, newest kept. Default ${DEFAULT_READ_CALLS}, at most ${MAX_READ_CALLS}.` },
      },
    },
  },
};
