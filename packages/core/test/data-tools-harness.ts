// Harness for the data tools' one definition (packages/core/src/data-tools.ts):
// each roster names its tools after their keys and
// covers every data tool, each input schema is a well-formed object schema,
// and each session schema accepts every property the worker's has (same
// name, same type) and requires nothing the worker doesn't — so one static
// MCP definition can't drift from the workers'. query_db's statement field is
// the worker's own object.
//
//   node out/packages/core/test/data-tools-harness.js
//
// Bare node. The worker wordings' bytes are pinned by the browser's
// authoring-golden-request harness, not here.

import { DATA_TOOL_NAMES, SESSION_DATA_TOOLS, WORKER_DATA_TOOLS, isDataToolName } from '../src/data-tools';
import { PAGE_TOOL_NAMES } from '../src/page-tools';
import { API_MAP_TOOL_NAMES } from '../src/api-map-tools';
import { COMPOSITION_SESSION_TOOL_NAMES } from '../src/composition-session-tools';
import type { ToolDefinition } from '../src/page-tools';

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const rosters: Array<[string, Record<string, ToolDefinition>]> = [
  ['worker', WORKER_DATA_TOOLS],
  ['session', SESSION_DATA_TOOLS],
];

console.log('rosters:');
for (const [label, roster] of rosters) {
  check(`${label}: every data tool, in order`, JSON.stringify(Object.keys(roster)) === JSON.stringify(DATA_TOOL_NAMES), Object.keys(roster).join(','));
  for (const [key, tool] of Object.entries(roster)) {
    check(`${label} ${key}: named after its key`, tool.name === key, tool.name);
    check(`${label} ${key}: is a data tool`, isDataToolName(key));
    check(`${label} ${key}: has a description`, typeof tool.description === 'string' && tool.description.length > 40);
    const schema = tool.input_schema;
    check(`${label} ${key}: object schema`, schema.type === 'object' && isRecord(schema.properties));
    for (const req of schema.required ?? []) {
      check(`${label} ${key}: required "${req}" is a property`, req in schema.properties);
    }
  }
}

console.log('session vs worker:');
for (const name of DATA_TOOL_NAMES) {
  const session = SESSION_DATA_TOOLS[name];
  const worker = WORKER_DATA_TOOLS[name];
  for (const [prop, def] of Object.entries(worker.input_schema.properties)) {
    const mine = session.input_schema.properties[prop];
    check(`session ${name} accepts "${prop}"`, isRecord(mine) && isRecord(def) && mine.type === def.type, JSON.stringify(mine));
  }
  for (const req of session.input_schema.required ?? []) {
    check(`session ${name} requires "${req}" only where the worker does`, (worker.input_schema.required ?? []).includes(req));
  }
  check(`session ${name} has no property the worker lacks`,
    Object.keys(session.input_schema.properties).every((p) => p in worker.input_schema.properties));
}
check('query_db\'s statement field is the worker\'s own object',
  SESSION_DATA_TOOLS.query_db.input_schema.properties.sql === WORKER_DATA_TOOLS.query_db.input_schema.properties.sql);

console.log('names:');
check('isDataToolName answers only the data tools', isDataToolName('query_db') && !isDataToolName('view_page') && !isDataToolName('read_calls'));
const others: readonly string[] = [...PAGE_TOOL_NAMES, ...API_MAP_TOOL_NAMES, ...COMPOSITION_SESSION_TOOL_NAMES];
check('no data tool shares a name with another session tool', DATA_TOOL_NAMES.every((n) => !others.includes(n)));

console.log('wording:');
check('the session query_db says it is read-only', /SELECT only/.test(SESSION_DATA_TOOLS.query_db.description) && /refused/.test(SESSION_DATA_TOOLS.query_db.description));
check('the session read_sibling_shim is shim-only and pack-only',
  /Shim sessions only/.test(SESSION_DATA_TOOLS.read_sibling_shim.description) && /same pack/.test(SESSION_DATA_TOOLS.read_sibling_shim.description));
for (const name of DATA_TOOL_NAMES) {
  check(`the session ${name} names no internal tool`, !/emit_shim_delta|emit_composition_delta|# Pack siblings/.test(SESSION_DATA_TOOLS[name].description));
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} failure(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);
