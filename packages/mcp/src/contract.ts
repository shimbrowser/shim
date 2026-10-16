// The static tool contract: every tool this server
// offers, registered once at startup — nothing depends on a mid-session
// tools/list_changed. The session tools are defined here; the page tools'
// one definition is @shimbrowser/core/page-tools, the same module Shim's own
// workers take theirs from, the API map tools' is
// @shimbrowser/core/api-map-tools (D13), the data tools' is
// @shimbrowser/core/data-tools, and the composition-only tools' is
// @shimbrowser/core/composition-session-tools.

import { SESSION_PAGE_TOOLS, PAGE_TOOL_NAMES, type ToolDefinition } from '@shimbrowser/core/page-tools';
import { SESSION_API_MAP_TOOLS, API_MAP_TOOL_NAMES } from '@shimbrowser/core/api-map-tools';
import { SESSION_DATA_TOOLS, DATA_TOOL_NAMES } from '@shimbrowser/core/data-tools';
import { SESSION_COMPOSITION_TOOLS, COMPOSITION_SESSION_TOOL_NAMES } from '@shimbrowser/core/composition-session-tools';

export const SESSION_TOOL_NAMES = [
  'shim_status',
  'shim_launch',
  'shim_list_tabs',
  'shim_open_session',
  'shim_checkout',
  'shim_preview',
  'shim_commit',
  'shim_end_session',
] as const;
export type SessionToolName = (typeof SESSION_TOOL_NAMES)[number];

const SESSION_ID = {
  type: 'string',
  description: 'The session to act on. Optional: defaults to the session this server opened most recently.',
};

export const SESSION_TOOLS: Record<SessionToolName, ToolDefinition> = {
  shim_status: {
    name: 'shim_status',
    description:
      'Report which authoring modes are available right now and why: attach (a tab in the running Shim browser, ' +
      'with the user\'s logins; needs Shim running with its control endpoint on) and headless (a fresh Chromium ' +
      'driven by Playwright, no Shim needed; needs Playwright installed — when it is not, the exact install command). ' +
      'Also the sessions this server opened, each with its mode, and what to do next. Call first.',
    input_schema: { type: 'object', properties: {} },
  },
  shim_launch: {
    name: 'shim_launch',
    description:
      'Attach to the running Shim browser, or start it with its control endpoint on for this run, and wait ' +
      'until it answers. Starting Shim grants nothing: every session still waits for the user to allow it in Shim.',
    input_schema: {
      type: 'object',
      properties: {
        timeoutSeconds: { type: 'number', description: 'How long to wait for Shim to answer after starting it. Default 60 (180 for a dev checkout).' },
      },
    },
  },
  shim_list_tabs: {
    name: 'shim_list_tabs',
    description:
      "List the Shim browser's open tabs per window: each tab's tabId (what shim_open_session targets), url, " +
      'title, whether it is the active tab, and for a site tab the shims that run on its host (id and name) and ' +
      'connect ("asks": opening a session shows the user a card; "allowed": they allowed this site until Shim ' +
      'quits, so none comes), for a composition tab its compositionId. Also lists every composition (id, name, ' +
      'mount, connect).',
    input_schema: { type: 'object', properties: {} },
  },
  shim_open_session: {
    name: 'shim_open_session',
    description:
      'Open an authoring session on one shim (against one of Shim\'s site tabs) or one composition. Unless the ' +
      'user already allowed that site (or composition) until Shim quits — shim_list_tabs says connect: "allowed" — ' +
      'they are asked in Shim to allow it (up to two minutes) and this call waits for the answer, so first tell the ' +
      'user to switch to Shim and allow the "coding agent wants to connect" card in its sidebar; with connect: ' +
      '"allowed" no card comes, so don\'t. The answer\'s consent says which happened ("asked" or "remembered"). ' +
      'Name an existing shim with ' +
      'shimId, start a new one on the tab\'s site with newShimName, name a composition with compositionId, or ' +
      'start a new composition with newCompositionName (and optionally the mount you propose for its ' +
      'compose://<mount> address; the user can change it before allowing, and the answer says which they chose). ' +
      'A composition\'s page opens in Shim as the preview; tabId is optional. Something new is kept only if you ' +
      'commit. Pass dir to check the work out into that folder ' +
      'right away (same as shim_checkout); unless the user named a folder, use <your working directory>/<name> (the ' +
      'shim or composition name, lowercased and hyphenated), never a temp or scratch folder, and tell the user ' +
      'where it is. While the session is open the shim or composition is yours alone; Shim ' +
      'ends it after 10 idle minutes, or when the user stops it or starts their own turn on it. ' +
      'Headless (no Shim browser needed): pass url instead of tabId. The session opens that page in its own ' +
      'Chromium, with no logins, and works on the .shim file shimFile (loaded when it exists; with newShimName, ' +
      'created by your first commit — default <dir>.shim). A url opens headless only while no Shim browser is ' +
      'reachable; with Shim running, use its tab (tabId) or pass mode "headless" explicitly. The answer always ' +
      'names the session\'s mode and why. Headless has no compositions.',
    input_schema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'The target tab, as shim_list_tabs reports it. Required for a shim in the Shim browser; optional for a composition (the window its preview opens in).' },
        intent: { type: 'string', description: 'What you set out to do, in a sentence or two. Shown to the user on the card in Shim and recorded in the chat when you commit.' },
        shimId: { type: 'string', description: 'An existing shim to work on (shim_list_tabs lists the ones on each tab\'s host).' },
        newShimName: { type: 'string', description: 'Instead of shimId: create a new shim with this name on the tab\'s site. It is kept only if you commit.' },
        compositionId: { type: 'string', description: 'Instead of a shim: the composition to work on (shim_list_tabs lists them).' },
        newCompositionName: { type: 'string', description: 'Instead of compositionId: create a new composition with this name (a manifest and an empty index.html to start from). It is kept only if you commit.' },
        mount: { type: 'string', description: 'With newCompositionName: the address to propose, compose://<mount> — lowercase letters, digits and hyphens, not starting with a hyphen, and not already taken. Omitted: Shim suggests one from the name. The user may change it.' },
        dir: { type: 'string', description: 'Optional absolute folder to check the working copy out into once the session opens. Default to <your working directory>/<name> unless the user named one; never a temp or scratch folder.' },
        url: { type: 'string', description: 'Headless mode only, instead of tabId: the http(s) page to open.' },
        shimFile: { type: 'string', description: 'Headless mode only, instead of shimId: the absolute path of the .shim file to work on. Commits write it.' },
        mode: {
          type: 'string',
          enum: ['attach', 'headless'],
          description: 'Optional. The default is attach for a tabId, and headless for a url while no Shim browser is reachable. Pass "headless" to open a url headless even with Shim running.',
        },
      },
      required: ['intent'],
    },
  },
  shim_checkout: {
    name: 'shim_checkout',
    description:
      "Write the session's working copy into a folder. A shim: shim.json (the spec, handlers referenced by name) " +
      'and handlers/<name>.js (one handler per file, `module.exports = function …`). A composition: manifest.json ' +
      'and every file of the composition, flat. The folder must be empty or an earlier checkout of the same kind. ' +
      'Edit those files, then shim_preview.',
    input_schema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Absolute path of the folder to write. Created if missing. Unless the user named one, <your working directory>/<name>, never a temp or scratch folder.' },
        sessionId: SESSION_ID,
      },
      required: ['dir'],
    },
  },
  shim_preview: {
    name: 'shim_preview',
    description:
      'Send the whole working-copy folder to Shim: it is validated, diffed against the session\'s working state, ' +
      'and applied at once. A shim applies to the live page; the evidence is per rule the match count and the ' +
      'matched element\'s measured box, handler errors with stacks, no-match and quarantine signals, lint errors ' +
      'and warnings, console errors since the previous preview. A composition\'s files are saved and its page ' +
      'reloads; the evidence is what changed, lint warnings, and console errors and warnings since the previous ' +
      'preview (a manifest adding a host asks the user in Shim first, and this call waits). Returns the new ' +
      'revision. Nothing is kept until shim_commit. A clean preview proves the work applied, not that it looks ' +
      'right: for a visual change, pass screenshot (or call view_page) and judge it before committing.',
    input_schema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'The working-copy folder. Defaults to the folder the session was checked out into.' },
        screenshot: { type: 'boolean', description: 'Also return a screenshot of the page after the preview applies.' },
        selector: { type: 'string', description: 'With screenshot: crop it to this CSS selector plus context margin.' },
        sessionId: SESSION_ID,
      },
    },
  },
  shim_commit: {
    name: 'shim_commit',
    description:
      'Save the previewed work as a new version of the shim or composition. Commits exactly the revision named ' +
      '(default: the latest preview); if a newer preview applied since, the answer is stale-revision. When the ' +
      'work declares something sensitive (a shim\'s redirect target, a composition\'s write to a site, a remote ' +
      'database connection) the user approves it in Shim first, and this call waits. A retry with the same ' +
      'commitId returns the first result, never a second commit. The session stays open: keep previewing and ' +
      'commit again.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What changed and why, in a few sentences. Recorded in the chat as your reply to the session\'s intent.' },
        revision: { type: 'number', description: 'The revision to commit, as shim_preview returned it. Defaults to the latest preview.' },
        commitId: { type: 'string', description: 'Your id for this commit, for a safe retry. Generated when omitted.' },
        sessionId: SESSION_ID,
      },
      required: ['summary'],
    },
  },
  shim_end_session: {
    name: 'shim_end_session',
    description:
      'End the session. Anything previewed but not committed is discarded: the page returns to the shim as ' +
      'committed, or the composition\'s files to its last commit. Note that actions your previews or ' +
      'evaluate_in_page took on a site are not undone.',
    input_schema: { type: 'object', properties: { sessionId: SESSION_ID } },
  },
};

// A page, API map, data or composition tool as this server registers it: core's
// session definition, plus the optional sessionId every session tool takes —
// so an agent holding two sessions can aim it at either. The server strips it
// before the call reaches Shim (whose tools never see it).
function withSessionId(tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    input_schema: { ...tool.input_schema, properties: { ...tool.input_schema.properties, sessionId: SESSION_ID } },
  };
}

/** Every tool, in registration order: session tools, page tools, the API map tools, the data tools, then the composition-only tools. */
export function staticTools(): ToolDefinition[] {
  return [
    ...SESSION_TOOL_NAMES.map((n) => SESSION_TOOLS[n]),
    ...PAGE_TOOL_NAMES.map((n) => withSessionId(SESSION_PAGE_TOOLS[n])),
    ...API_MAP_TOOL_NAMES.map((n) => withSessionId(SESSION_API_MAP_TOOLS[n])),
    ...DATA_TOOL_NAMES.map((n) => withSessionId(SESSION_DATA_TOOLS[n])),
    ...COMPOSITION_SESSION_TOOL_NAMES.map((n) => withSessionId(SESSION_COMPOSITION_TOOLS[n])),
  ];
}

export function isSessionToolName(name: string): name is SessionToolName {
  return (SESSION_TOOL_NAMES as readonly string[]).includes(name);
}

export const SERVER_INSTRUCTIONS =
  'Shim is a browser that applies user-authored modifications ("shims") to live websites, and serves ' +
  '"compositions": small local web apps that read sites\' APIs with the user\'s session. These tools author ' +
  'both against the running Shim browser: shim_status / shim_launch, shim_list_tabs, shim_open_session on a ' +
  'site tab (a shim) or a composition (the user allows it in Shim), shim_checkout into a folder, edit the ' +
  'files (shim.json and handlers/*.js; or manifest.json and the composition\'s files), shim_preview to apply ' +
  'the folder and read the evidence, the page tools (view_page, query_page, inspect_element, interact_page ' +
  'for a composition, …) to look, then shim_commit with a summary, and shim_end_session. For a visual change, ' +
  'verify with a screenshot before committing. When the work needs a site\'s own API, the API map tools ' +
  '(list_discovered_hosts, request_sources, search_discovered_api, inspect_endpoint, replay_endpoint) read ' +
  'what Shim recorded of it, per site the user grants. inspect_storage and query_db read what the work has ' +
  'saved, and read_sibling_shim a shim\'s pack siblings; a composition session also has probe_request, ' +
  'read_calls and verify_mint. The shim-authoring skill documents both formats, every mutation kind, anchors, the runtime ' +
  'api and window.api.';

export const HEADLESS_SERVER_INSTRUCTIONS =
  'Shim applies user-authored modifications ("shims") to live websites. This server runs in HEADLESS mode: no ' +
  'Shim browser — each session drives its own Chromium page (no logins) and works on a .shim file. ' +
  'shim_open_session with url, intent and shimFile (plus newShimName for a new shim) and dir, edit shim.json and ' +
  'handlers/*.js, shim_preview to apply the folder to the live page and read the evidence, the page tools ' +
  '(view_page, query_page, inspect_element, …) to look, then shim_commit (it writes the .shim file) and ' +
  'shim_end_session. Headless supports a subset of shim features: a preview that declares anything else answers ' +
  '"unsupported" and applies nothing, and a rule reported verification "partial" is unverified — tell the user. ' +
  'Compositions, the API map tools and other tools that need the Shim browser answer requires-shim-browser. ' +
  'The shim-authoring skill documents the spec format, every mutation kind, anchors and the runtime api.';

export const AUTO_SERVER_INSTRUCTIONS =
  'Shim applies user-authored modifications ("shims") to live websites. This server authors shims in two modes, ' +
  'the same tools in both: ATTACH works on a tab in the running Shim browser (the user\'s logins; the user allows ' +
  'each session in Shim; commits go to Shim\'s library), HEADLESS needs no Shim and drives its own Chromium per ' +
  'session (no logins; commits write a .shim file). Call shim_status first: it says which modes are available, ' +
  'why, and what to do next. Attach: shim_list_tabs, shim_open_session with tabId. Headless: shim_open_session with ' +
  'url, intent, newShimName (or shimFile) and dir. Then edit shim.json and handlers/*.js, shim_preview to apply ' +
  'the folder to the live page and read the evidence, the page tools (view_page, query_page, inspect_element, …) ' +
  'to look, shim_commit with a summary, and shim_end_session. For a visual change, verify with a screenshot ' +
  'before committing. Headless supports a subset of shim features: a preview declaring anything else answers ' +
  '"unsupported", and a rule reported verification "partial" is unverified — tell the user. Attach sessions also ' +
  'author compositions (compositionId or newCompositionName) and have the API map and data tools; a headless ' +
  'session answers requires-shim-browser for those. The shim-authoring skill documents the spec format, every ' +
  'mutation kind, anchors, the runtime api and window.api.';
