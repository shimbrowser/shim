// The API map tools for an external session:
// what @shimbrowser/mcp registers statically so an agent driving a session
// (Claude Code) can read the host sites' recorded API — Shim's Discovery
// map — and check an endpoint still answers. ONE definition per tool, here.
//
// The browser's own workers keep their wordings (the shim worker's
// single-host search / inspect / replay, the composition worker's
// propose_sources flow): those are part of every internal authoring request,
// whose bytes must not change. A session's tools differ in what they may
// reach, so they are worded for that:
//
//   - Two consent levels. list_discovered_hosts answers the NAMES of the
//     sites with a recorded API map once the user allows it (asked the first
//     time, once per session). A site's content — endpoints, schemas, replay
//     — opens per site through request_sources, which pops a card in Shim.
//   - Every content call names a host, and answers only for a site the
//     session was granted. An endpoint id resolving to another site's
//     endpoint is "not found".
//   - inspect_endpoint returns the schema only: captured sample bodies never
//     leave Shim. replay_endpoint returns a status and shape confirmation,
//     never the response body.
//   - Replay keeps each kind's rule: in a shim session GET / HEAD run and
//     another method asks the user once per (site, method, path); in a
//     composition session anything but GET / HEAD is refused.
//
// Pure data, like page-tools.ts.

import type { ToolDefinition } from './page-tools';

export const API_MAP_TOOL_NAMES = [
  'list_discovered_hosts',
  'request_sources',
  'search_discovered_api',
  'inspect_endpoint',
  'replay_endpoint',
] as const;
export type ApiMapToolName = (typeof API_MAP_TOOL_NAMES)[number];

export function isApiMapToolName(name: string): name is ApiMapToolName {
  return (API_MAP_TOOL_NAMES as readonly string[]).includes(name);
}

/** At most this many sites per request_sources call. */
export const MAX_SOURCES_PER_REQUEST = 10;

const HOST = {
  type: 'string',
  description: 'The site, exactly as list_discovered_hosts / request_sources name it (e.g. "api.example.com"). It must be granted to this session.',
};
const ENDPOINT_ID = { type: 'number', description: 'Endpoint id, as search_discovered_api returned it for this host.' };
const TEMPLATE = {
  type: 'string',
  description: "path_template (REST) or operation_name (GraphQL / JSON-RPC / tRPC), when you don't have the id.",
};

export const SESSION_API_MAP_TOOLS: Record<ApiMapToolName, ToolDefinition> = {
  list_discovered_hosts: {
    name: 'list_discovered_hosts',
    description:
      'List the names of the sites Shim has recorded an API map for (Discovery captures the shape of the ' +
      "requests a site's own pages make), and which of them this session may already read. The first call " +
      'in a session asks the user in Shim to allow it and waits for the answer; it opens the names only, ' +
      'nothing about any site. Use it to suggest sources, then request_sources for the sites you need.',
    input_schema: { type: 'object', properties: {} },
  },
  request_sources: {
    name: 'request_sources',
    description:
      "Ask the user, on a card in Shim, to let this session read the named sites' API maps: their endpoints, " +
      'schemas and summaries, and replaying them. Waits for the answer. Each granted site lasts for the ' +
      'session (the user can revoke it from Shim at any time); sites already granted are not asked again. ' +
      `At most ${MAX_SOURCES_PER_REQUEST} sites per call. Answers which sites were granted, and which of ` +
      'those have no recorded API map yet. With Discovery off in Shim it still asks and grants (a composition ' +
      "session's probe_request needs only the grant) and lists every site under noApiMap; the other API map " +
      'tools then answer discovery-off.',
    input_schema: {
      type: 'object',
      properties: {
        hosts: { type: 'array', items: { type: 'string' }, description: 'The sites to ask for, by host name.' },
        why: { type: 'string', description: 'One sentence shown on the card: what you need these sites\' APIs for.' },
      },
      required: ['hosts'],
    },
  },
  search_discovered_api: {
    name: 'search_discovered_api',
    description:
      'Search the granted sites\' recorded endpoints for a natural-language description (e.g. "track ' +
      'details", "add to favorites", "user profile"). Returns up to 10 candidates ranked by relevance, each ' +
      'with its site, id, method, kind, path template, operation name, one-line summary, fidelity, sample ' +
      'count and last-seen time — breadth only, no schema. Name a host to search one site; omit it to search ' +
      'every site granted to this session. Then inspect_endpoint the one that looks right.',
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'What the endpoint you need does.' },
        host: { ...HOST, description: 'Optional: search only this granted site.' },
      },
      required: ['description'],
    },
  },
  inspect_endpoint: {
    name: 'inspect_endpoint',
    description:
      'The inferred schema of one recorded endpoint on a granted site: its request query schema, its response ' +
      'schema (and a GraphQL endpoint\'s introspected schema when one was captured), and how many samples ' +
      'back it. Schema only — captured bodies stay in Shim. Look it up by the id search_discovered_api ' +
      'returned, or by template (+ method to disambiguate). Read it before writing code that calls the ' +
      'endpoint; never guess field names from the summary.',
    input_schema: {
      type: 'object',
      properties: {
        host: HOST,
        endpointId: ENDPOINT_ID,
        template: TEMPLATE,
        method: { type: 'string', description: 'HTTP method, to disambiguate a template lookup.' },
      },
      required: ['host'],
    },
  },
  replay_endpoint: {
    name: 'replay_endpoint',
    description:
      "Call a recorded endpoint on a granted site through the user's signed-in browser session, to check it " +
      'still answers as recorded. Returns the status, an item count and whether the response still matches ' +
      'the recorded shape — never the response body. GET and HEAD run at once. In a shim session any other ' +
      'method first asks the user on a card in Shim, once per site, method and path, and replays the body ' +
      'last observed from the site unless you pass body; in a composition session only GET and HEAD are ' +
      'allowed. It acts on the real site as the user.',
    input_schema: {
      type: 'object',
      properties: {
        host: HOST,
        endpointId: ENDPOINT_ID,
        template: TEMPLATE,
        method: { type: 'string', description: "HTTP method to replay with. Defaults to the endpoint's own." },
        body: { type: 'string', description: 'Shim sessions, non-GET only: the request body to send instead of the observed one.' },
      },
      required: ['host'],
    },
  },
};
