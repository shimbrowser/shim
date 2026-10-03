// The data tools (shim-core design D2, §5): read what an artifact has saved
// — inspect_storage, query_db — and, for a shim in a pack, a sibling's
// source — read_sibling_shim. ONE definition per tool, here, for every
// caller:
//
//   WORKER_DATA_TOOLS   what the Shim browser's workers offer (the shim
//                       worker all three; the composition worker
//                       inspect_storage and query_db, the same objects)
//   SESSION_DATA_TOOLS  what @shimbrowser/mcp registers statically for an
//                       external agent (Claude Code) driving a session
//
// The worker wordings are load-bearing: they are part of every internal
// authoring request, and the browser's golden-request harness pins the shim
// roster byte for byte (key order included). Moved here unchanged.
//
// The session wording covers both session kinds with one static definition
// (D2: no mid-session list_changed); its input schemas accept every property
// the worker's do. All three only read: query_db is read-only by
// construction (the browser classifies the statement before it reaches the
// database and refuses anything but a read), inspect_storage dumps, and
// read_sibling_shim reads one sibling of the shim's own pack, never another
// shim.
//
// Pure data, like page-tools.ts.

import type { ToolDefinition } from './page-tools';

export const DATA_TOOL_NAMES = ['inspect_storage', 'query_db', 'read_sibling_shim'] as const;
export type DataToolName = (typeof DATA_TOOL_NAMES)[number];

export function isDataToolName(name: string): name is DataToolName {
  return (DATA_TOOL_NAMES as readonly string[]).includes(name);
}

// --- the workers' wordings ----------------------------------------------------

// Read what an artifact has persisted via api.storage. Crucial for debugging
// stateful shims/compositions — without this the model can see the code
// that writes to storage but not the values that are actually there. Called
// only when the model needs storage state to make its next change; not a
// default per-turn fetch (would burn tokens on shims that don't use storage
// at all). The runner is patchId-scoped on the main side so the model can't
// read another shim's data.
const WORKER_INSPECT_STORAGE: ToolDefinition = {
  name: 'inspect_storage',
  description:
    "Read everything the current shim has saved to api.storage. Use this " +
    "when iterating on a stateful shim and the user's ask depends on what's " +
    "already saved — e.g. they say 'the counter is wrong', 'stamps don't " +
    "persist', 'why is it stuck on the old value'. Returns one row per " +
    "(origin, key) with the parsed JSON value. Don't call speculatively — " +
    "skip when the shim has no script handlers, or when the change is " +
    "purely stylistic. For a shim in a pack, the result also carries " +
    "packRows — the pack-shared bucket (api.storage.pack). For a shim " +
    "declaring spec.storage, the result also carries dbSchema — the live " +
    "database's tables and row counts.",
  input_schema: {
    type: 'object',
    properties: {},
  },
};

// Read-only SQL escape hatch for a shim declaring spec.storage (§ api.db,
// shim-db foundation). inspect_storage answers "what's saved"; this
// answers "how many rows match X" / "what does row Y actually look like" —
// questions api.storage's simple KV shape can't express and inspect_storage's
// full dump doesn't scale to. SELECT-only by design: the broker classifies
// the statement before it ever reaches the pipeline and refuses anything
// else — writes/DDL go through a handler's own api.db.run (with its normal
// approval flow) or a set-storage op, never this tool.
const QUERY_DB_SQL = {
  type: 'string',
  description:
    'A single SELECT statement — UNLESS "connection" names a supabase ' +
    'connection, in which case this field is instead a JSON-encoded ' +
    'read op. With a filter: { "table": "notes", "verb": "select", ' +
    '"columns": "*", "filters": [{ "column": "user_id", "op": "eq", ' +
    '"value": 1 }], "orFilters": [], "modifiers": { "limit": 20 } }. ' +
    'With no filter (every row, still bounded by modifiers.limit): ' +
    '{ "table": "notes", "verb": "select", "columns": "*", "filters": [], ' +
    '"orFilters": [], "modifiers": { "limit": 20 } } — filters/orFilters ' +
    'are required arrays even when empty. "filters" entries use op ' +
    'eq/neq/gt/gte/lt/lte/like/ilike/in/is; negate one with the composite ' +
    'form "not.<op>" (e.g. "not.eq") instead of a separate negation field. ' +
    '"orFilters" entries are raw PostgREST .or() strings instead — comma-' +
    'joined "column.op.value" leaves (op one of eq/neq/gt/gte/lt/lte/like/' +
    'ilike/in/is/not/cs/cd), optionally wrapped in ONE level of and(...)/' +
    'or(...) groups, e.g. "status.eq.active,and(age.gt.18,verified.is.true)". ' +
    'supabase has no SQL surface here, only this op shape. verb must be ' +
    '"select"; any other verb is refused.',
};

const WORKER_QUERY_DB: ToolDefinition = {
  name: 'query_db',
  description:
    "Run a read-only SQL query against the current shim's local database " +
    "(the spec.storage tables). Use it to verify what the shim's handlers " +
    "have actually written — row counts, recent rows, a value the user says " +
    "is wrong. SELECT only: writes and DDL are refused (emit handler code " +
    "or a set-storage op for those). Results are capped; add LIMIT.",
  input_schema: {
    type: 'object',
    properties: {
      sql: QUERY_DB_SQL,
      connection: {
        type: 'string',
        description:
          'Optional. The name of a declared remote connection (spec.connections) ' +
          "to query instead of the shim's own local database. Omit to query " +
          "local storage. Still read-only — writes and DDL against a remote " +
          'connection are refused exactly the same as against local (for a ' +
          'supabase connection this means only verb: "select" is accepted — ' +
          'see the "sql" field above). If the named connection is declared ' +
          'but the user has not yet saved a URL for it, the call resolves an ' +
          'error instead of running.',
      },
    },
    required: ['sql'],
  },
};

// Read a pack sibling's full source on demand (§21). The ambient digest
// (# Pack siblings) carries every sibling's shape; this returns one
// sibling's complete spec + handler source + recent chat when the model
// actually needs depth — before rebuilding something a sibling already
// built, or to copy its conventions (storage keys, class prefixes).
// Read-only, main-side only; no page interaction.
const WORKER_READ_SIBLING_SHIM: ToolDefinition = {
  name: 'read_sibling_shim',
  description:
    'Read a pack sibling shim in full: its spec JSON, every handler\'s ' +
    'source, and its last few authoring exchanges. Use when the sibling ' +
    'digest in context is not enough — e.g. before building something ' +
    'that composes with a sibling\'s data or conventions. Name a sibling ' +
    'exactly as listed under "# Pack siblings".',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The sibling shim\'s name as shown in the digest.' },
    },
    required: ['name'],
  },
};

export const WORKER_DATA_TOOLS: Record<DataToolName, ToolDefinition> = {
  inspect_storage: WORKER_INSPECT_STORAGE,
  query_db: WORKER_QUERY_DB,
  read_sibling_shim: WORKER_READ_SIBLING_SHIM,
};

// --- the session wordings -----------------------------------------------------

export const SESSION_DATA_TOOLS: Record<DataToolName, ToolDefinition> = {
  inspect_storage: {
    name: 'inspect_storage',
    description:
      'Read everything the shim or composition has saved — its committed data, which previews never touch (a ' +
      "previewed handler's api.storage is a scratch bucket). Returns one row per (origin, key) of api.storage " +
      'with the parsed JSON value; for a shim in a pack also packRows (api.storage.pack); for a global shim ' +
      'globalRows (api.storage.global); when storage tables are declared, dbSchema — the live database\'s ' +
      'tables and row counts; for a composition, each declared remote connection and whether the user has ' +
      'configured it (never its URL). Read-only. Use it when the ask depends on what is already saved ("the ' +
      'counter is wrong", "notes don\'t persist"); don\'t call it speculatively.',
    input_schema: { type: 'object', properties: {} },
  },
  query_db: {
    name: 'query_db',
    description:
      "Run a read-only SQL query against the shim's or composition's own local database (the tables its " +
      '`storage` declares), or a declared remote connection. Use it to check what the handlers or the page ' +
      'actually wrote — row counts, recent rows, a value the user says is wrong. SELECT only: writes and DDL ' +
      'are refused, before anything reaches the database. Results are capped; add LIMIT. Nothing to query ' +
      '(no tables declared, or a connection the user hasn\'t configured) answers an error.',
    input_schema: {
      type: 'object',
      properties: {
        sql: QUERY_DB_SQL,
        connection: {
          type: 'string',
          description:
            'Optional. The name of a declared remote connection (`connections`) to query instead of the local ' +
            'database. Still read-only (for a supabase connection only verb "select" is accepted — see "sql").',
        },
      },
      required: ['sql'],
    },
  },
  read_sibling_shim: {
    name: 'read_sibling_shim',
    description:
      'Shim sessions only. Read another shim in the same pack as this one, in full: its spec JSON, every ' +
      'handler\'s source, and its last few authoring exchanges — before building something that composes with ' +
      'a sibling\'s data or conventions (storage keys, class prefixes). Only siblings of this shim\'s pack: a ' +
      'shim in no pack answers that it has none, and an unknown name answers the valid names. Read-only.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The sibling\'s name, as Shim shows it (case-insensitive).' },
      },
      required: ['name'],
    },
  },
};
