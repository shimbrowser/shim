// The static tool contract (shim-core design D2, §5): every tool this server
// offers, registered once at startup — nothing depends on a mid-session
// tools/list_changed. The session tools are defined here; the page tools'
// one definition is @shimbrowser/core/page-tools, the same module Shim's own
// workers take theirs from.

import { SESSION_PAGE_TOOLS, PAGE_TOOL_NAMES, type ToolDefinition } from '@shimbrowser/core/page-tools';

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
      'Report whether the Shim browser is running with its control endpoint on, its version, and the ' +
      'sessions open on it. Call first; if Shim is not reachable, call shim_launch.',
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
      'title, whether it is the active tab, and for a site tab the shims that run on its host (id and name).',
    input_schema: { type: 'object', properties: {} },
  },
  shim_open_session: {
    name: 'shim_open_session',
    description:
      "Open an authoring session on one shim against one of Shim's site tabs. The user is asked in Shim to " +
      'allow it (up to two minutes); this call waits for the answer. Name an existing shim with shimId, or ' +
      'start a new one on the tab\'s site with newShimName. Pass dir to check the shim out into that folder ' +
      'right away (same as shim_checkout). While the session is open the shim is yours alone; Shim ends it ' +
      'after 10 idle minutes, or when the user stops it or starts their own turn on that shim.',
    input_schema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'The target tab, as shim_list_tabs reports it.' },
        intent: { type: 'string', description: 'What you set out to do, in a sentence or two. Shown to the user on the card in Shim and recorded in the shim\'s chat when you commit.' },
        shimId: { type: 'string', description: 'An existing shim to work on (shim_list_tabs lists the ones on each tab\'s host).' },
        newShimName: { type: 'string', description: 'Instead of shimId: create a new shim with this name on the tab\'s site. It is kept only if you commit.' },
        dir: { type: 'string', description: 'Optional absolute folder to check the working copy out into once the session opens.' },
      },
      required: ['tabId', 'intent'],
    },
  },
  shim_checkout: {
    name: 'shim_checkout',
    description:
      "Write the session's working copy into a folder: shim.json (the spec, handlers referenced by name) and " +
      'handlers/<name>.js (one handler per file, `module.exports = function …`). The folder must be empty or ' +
      'an earlier checkout. Edit those files, then shim_preview.',
    input_schema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Absolute path of the folder to write. Created if missing.' },
        sessionId: SESSION_ID,
      },
      required: ['dir'],
    },
  },
  shim_preview: {
    name: 'shim_preview',
    description:
      'Send the whole working-copy folder to Shim: it is linted, diffed against the session\'s working state, ' +
      'and applied to the live page at once. Returns the new revision and the evidence: per rule the match ' +
      'count and the matched element\'s measured box, handler errors with stacks, no-match and quarantine ' +
      'signals, lint errors and warnings, console errors since the previous preview. Nothing is saved until ' +
      'shim_commit. A clean preview proves the rules attached, not that the result looks right: for a visual ' +
      'change, pass screenshot (or call view_page) and judge it before committing.',
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
      'Save the previewed work as a new version of the shim. Commits exactly the revision named (default: the ' +
      'latest preview); if a newer preview applied since, the answer is stale-revision. When the work declares ' +
      'something sensitive (a redirect target, a remote database connection) the user approves it in Shim ' +
      'first, and this call waits. A retry with the same commitId returns the first result, never a second ' +
      'commit. The session stays open: keep previewing and commit again.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What changed and why, in a few sentences. Recorded in the shim\'s chat as your reply to the session\'s intent.' },
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
      'End the session. Anything previewed but not committed is discarded and the page returns to the shim as ' +
      'committed. Note that actions your previews or evaluate_in_page took on the site are not undone.',
    input_schema: { type: 'object', properties: { sessionId: SESSION_ID } },
  },
};

/** Every tool, in registration order: session tools, then page tools. */
export function staticTools(): ToolDefinition[] {
  return [
    ...SESSION_TOOL_NAMES.map((n) => SESSION_TOOLS[n]),
    ...PAGE_TOOL_NAMES.map((n) => SESSION_PAGE_TOOLS[n]),
  ];
}

export function isSessionToolName(name: string): name is SessionToolName {
  return (SESSION_TOOL_NAMES as readonly string[]).includes(name);
}

export const SERVER_INSTRUCTIONS =
  'Shim is a browser that applies user-authored modifications ("shims") to live websites. These tools author ' +
  'shims against the running Shim browser: shim_status / shim_launch, shim_list_tabs, shim_open_session on a ' +
  'site tab (the user allows it in Shim), shim_checkout into a folder, edit shim.json and handlers/*.js, ' +
  'shim_preview to apply the folder to the live page and read the evidence, the page tools (view_page, ' +
  'query_page, inspect_element, …) to look, then shim_commit with a summary, and shim_end_session. For a ' +
  'visual change, verify with a screenshot before committing. The shim-authoring skill documents the spec ' +
  'format, every mutation kind, anchors and the runtime api.';
