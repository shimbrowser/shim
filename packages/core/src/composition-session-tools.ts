// The composition-only session tools: what
// @shimbrowser/mcp registers statically, beside the page and API map tools,
// for an agent driving a composition session. ONE definition per tool, here.
//
//   probe_request  one GET of the agent's own through the composition's real
//                  fetch path (grants, mint, same-host redirects) — the API
//                  map group, composition sessions only
//   read_calls     the composition's broker call trace: the requests its
//                  page made, identity and status only — the data group
//   verify_mint    a proposed mint config run end to end against the user's
//                  session, behind a card in Shim for the mint host (and a
//                  follow host) — the API map group, composition sessions
//                  only
//
// A shim session answers all three as not offered. Also here: the answer and the
// note a session gives when its page (a composition's, or a shim handler on
// the session's tab) calls api.ai (D16 — an external session never spends the
// user's key, invariant 4).
//
// Pure data, like page-tools.ts.

import type { ToolDefinition } from './page-tools';

export const COMPOSITION_SESSION_TOOL_NAMES = ['probe_request', 'read_calls', 'verify_mint'] as const;
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

/**
 * The same, for a shim session: a handler on the session's tab called api.ai
 * (a previewed one, or the shim's committed rules there) and was refused.
 */
export const AI_UNAVAILABLE_SHIM_USER_MESSAGE =
  "Shim can't use your Claude Code subscription, so AI features in this shim won't run while Claude Code " +
  'builds it. Once the session ends, reload the page in Shim (with an API key set) to see them work.';

export const SESSION_COMPOSITION_TOOLS: Record<CompositionSessionToolName, ToolDefinition> = {
  probe_request: {
    name: 'probe_request',
    description:
      'Composition sessions only. Make one GET yourself through the composition\'s real fetch path (its ' +
      'grants, mint and same-host redirects) to a host that is all three: declared in the manifest, allowed ' +
      'for the composition by the user, and granted to this session with request_sources — for an endpoint\'s ' +
      'live response shape Discovery never captured. Returns the status and, for a JSON or form body, up to ' +
      '20,000 characters of it; nothing is stored. Anti-forgery token values in it (CSRF / XSRF fields, ' +
      'modhash, authenticity_token, …) read "[redacted: csrf]" (the field is kept; you never need the value — ' +
      'writes go through the page\'s declared operations), and a string value that names such a token reads ' +
      '"[redacted: possible csrf]". Any other body (HTML, script, text, XML) is never shown: you get ' +
      '`withheld` { format, bytes } instead. A probe is your request, not the page\'s: it never shows up in ' +
      'read_calls and is no evidence the page works. A host the manifest does not declare yet must be added ' +
      'to manifest.json and previewed first (the user is asked in Shim to allow a new host). GET only.',
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
  verify_mint: {
    name: 'verify_mint',
    description:
      'Composition sessions only. Check a proposed mint config (how the composition gets the token an API ' +
      'wants from the user\'s live session) end to end against the real session, before you put it in ' +
      'manifest.json. Shim first asks the user, on a card, to let the mint host be called with their session ' +
      '(and, with `follow`, the follow host too) and waits for the answer; nothing is requested before that. ' +
      'Declined or unanswered in two minutes, it answers `denied`. Two ways to read the token: `tokenPath`, a ' +
      'dot-path into a JSON mint response; or `token` { after, chars, length? }, the run of `chars` right after ' +
      'the literal text `after` in an HTML/JS response (e.g. after `client_id:"`, chars `A-Za-z0-9`, length 32). ' +
      'With `token`, `follow` { urlAfter, urlHost, max?, fromEnd? } first finds URLs in the mint page right ' +
      'after the literal `urlAfter` (e.g. `src="`) on `urlHost` and reads the token from the first of them that ' +
      'has it — how a key embedded in a site\'s JS bundle is found. Two ways to send it: `header` (+ optional ' +
      '`scheme`, e.g. "Bearer") or `query` (a query parameter name, e.g. "client_id"). No redirects are ' +
      'followed. Optionally confirm the token authenticates against `testEndpoint`, a read-only endpoint on the ' +
      'mint host\'s site (same registrable domain: a mint on auth.example.com can test api.example.com, never ' +
      'api.example.net), and either on the mint host itself or on a host granted to this session, declared and ' +
      'allowed — otherwise `test-host-not-allowed` before any card. Never returns the token or any body — only whether extraction worked (with `detail` ' +
      'when it did not) and, if tested, the status. probe_request shows JSON bodies only, so for a token in ' +
      'an HTML page or a script, ask the user where it sits, or try candidate prefixes here: the answer says ' +
      'whether extraction worked.',
    input_schema: {
      type: 'object',
      properties: {
        config: {
          type: 'object',
          description: 'The proposed mint config: url, exactly one of tokenPath / token, optional follow (with token), exactly one of header / query.',
          properties: {
            url: { type: 'string', description: 'https URL of the mint endpoint or page.' },
            tokenPath: { type: 'string', description: 'Dot-path into a JSON response where the token lives.' },
            token: {
              type: 'object',
              description: 'A token read from text: the run of `chars` right after the literal `after`.',
              properties: {
                after: { type: 'string' },
                chars: { type: 'string', description: 'Character-class body: letters, digits, _ - . ~ + / = and ranges like A-Z.' },
                length: { type: 'number', description: 'Exact token length (8-512); omit for any run of 8-512.' },
              },
            },
            follow: {
              type: 'object',
              description: 'Read the token from pages the mint page links to on urlHost (requires `token`).',
              properties: {
                urlAfter: { type: 'string' },
                urlHost: { type: 'string' },
                max: { type: 'number', description: 'Pages to try, 1-12 (default 8).' },
                fromEnd: { type: 'boolean', description: 'Try the last-linked pages first.' },
              },
            },
            header: { type: 'string', description: 'Header to send the token in, e.g. "Authorization".' },
            scheme: { type: 'string', description: 'Optional header scheme prefix, e.g. "Bearer".' },
            query: { type: 'string', description: 'Query parameter to send the token in, e.g. "client_id".' },
            expiresPath: { type: 'string', description: 'tokenPath mints only: dot-path to an expiry (ms epoch or ISO).' },
          },
          required: ['url'],
        },
        testEndpoint: {
          type: 'object',
          description: 'Optional: a read-only endpoint to call with the minted token, to confirm it authenticates. Its host must share the mint host\'s registrable domain, and be the mint host itself or a host granted to this session (request_sources), declared in manifest.json and allowed.',
          properties: {
            host: { type: 'string' },
            method: { type: 'string' },
            path: { type: 'string' },
          },
        },
      },
      required: ['config'],
    },
  },
};
