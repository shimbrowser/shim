// Harness for the page tools' one definition (packages/core/src/page-tools.ts):
// every roster names each tool after its key, every
// input schema is a well-formed object schema, the session roster covers
// every page tool, and each session schema accepts every property either
// worker's schema has (same name, same type) — so one static MCP definition
// serves both session kinds and can't drift from the workers'.
//
//   node out/packages/core/test/page-tools-harness.js
//
// Bare node. The worker wordings' bytes are pinned by the browser's
// authoring-golden-request harness, not here.

import {
  SHIM_PAGE_TOOLS, COMPOSITION_PAGE_TOOLS, SESSION_PAGE_TOOLS, PAGE_TOOL_NAMES, isPageToolName,
} from '../src/page-tools';
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
  ['shim', SHIM_PAGE_TOOLS],
  ['composition', COMPOSITION_PAGE_TOOLS],
  ['session', SESSION_PAGE_TOOLS],
];

console.log('rosters:');
for (const [label, roster] of rosters) {
  for (const [key, tool] of Object.entries(roster)) {
    check(`${label} ${key}: named after its key`, tool.name === key, tool.name);
    check(`${label} ${key}: is a page tool`, isPageToolName(key));
    check(`${label} ${key}: has a description`, typeof tool.description === 'string' && tool.description.length > 40);
    const schema = tool.input_schema;
    check(`${label} ${key}: object schema`, schema.type === 'object' && isRecord(schema.properties));
    for (const req of schema.required ?? []) {
      check(`${label} ${key}: required "${req}" is a property`, req in schema.properties);
    }
  }
}

console.log('session roster:');
check('the session roster has every page tool, in order',
  JSON.stringify(Object.keys(SESSION_PAGE_TOOLS)) === JSON.stringify(PAGE_TOOL_NAMES), Object.keys(SESSION_PAGE_TOOLS).join(','));
// navigate is a session's only, and interact_page the shim worker's never
// (the internal shim worker gets neither).
check('the shim worker offers every page tool but interact_page and navigate',
  JSON.stringify(Object.keys(SHIM_PAGE_TOOLS).sort()) === JSON.stringify(PAGE_TOOL_NAMES.filter((n) => n !== 'interact_page' && n !== 'navigate').sort()));
check('the composition worker offers every page tool but navigate',
  JSON.stringify(Object.keys(COMPOSITION_PAGE_TOOLS).sort()) === JSON.stringify(PAGE_TOOL_NAMES.filter((n) => n !== 'navigate').sort()));

for (const name of PAGE_TOOL_NAMES) {
  const session = SESSION_PAGE_TOOLS[name];
  const workers: ToolDefinition[] = [];
  if (name !== 'navigate') workers.push(COMPOSITION_PAGE_TOOLS[name]);
  if (name !== 'interact_page' && name !== 'navigate') workers.push(SHIM_PAGE_TOOLS[name]);
  for (const worker of workers) {
    for (const [prop, def] of Object.entries(worker.input_schema.properties)) {
      const mine = session.input_schema.properties[prop];
      check(`session ${name} accepts "${prop}"`, isRecord(mine) && isRecord(def) && mine.type === def.type,
        JSON.stringify(mine));
    }
    // A property every worker requires, the session requires too; the session
    // requires nothing a worker doesn't.
    for (const req of session.input_schema.required ?? []) {
      check(`session ${name} requires "${req}" only where a worker does`, (worker.input_schema.required ?? []).includes(req));
    }
  }
}

console.log('wording:');
check('the shim evaluate names the shim emit tool', SHIM_PAGE_TOOLS.evaluate_in_page.description.includes('emit_shim_delta'));
check('the composition evaluate names its own emit tool',
  COMPOSITION_PAGE_TOOLS.evaluate_in_page.description.includes('emit_composition_delta')
  && !COMPOSITION_PAGE_TOOLS.evaluate_in_page.description.includes('emit_shim_delta'));
for (const name of PAGE_TOOL_NAMES) {
  const text = SESSION_PAGE_TOOLS[name].description;
  check(`session ${name} names no internal emit tool`, !/emit_(shim|composition)_delta/.test(text), text);
}
check('the session evaluate points at shim_preview', SESSION_PAGE_TOOLS.evaluate_in_page.description.includes('shim_preview'));
check('the session view_page makes visual verification a duty',
  /VISUAL VERIFICATION/.test(SESSION_PAGE_TOOLS.view_page.description) && /shim_preview/.test(SESSION_PAGE_TOOLS.view_page.description));
const interact = SESSION_PAGE_TOOLS.interact_page.description;
check('the session interact_page covers both kinds and says what each may touch',
  /COMPOSITION session/.test(interact) && /ATTACH SHIM session/.test(interact) && /HEADLESS shim session/.test(interact)
  && /shim-dom/.test(interact) && /"page"/.test(interact));
check('…names every attach refusal code', ['not-shim-dom', 'other-shim-dom', 'site-activation', 'frame-unsupported', 'shadow-unsupported', 'focus-not-shim'].every((c) => interact.includes(c)));
check('…says site traffic is not observed, never "no requests"', /traffic: "not observed"/.test(interact) && /calls: null/.test(interact));
check('…says the user\'s own input stops the batch', /interrupted: "user"/.test(interact));
check('the session interact_page never promises api.ai runs', !/api\.ai runs/.test(interact));
check('the session interact_page accepts a scroll step', /"scroll": \{"by": px\}/.test(String((SESSION_PAGE_TOOLS.interact_page.input_schema.properties.actions as { description?: string }).description)));
const navigate = SESSION_PAGE_TOOLS.navigate;
check('navigate is shim-session-only and says so', /^Shim sessions only/.test(navigate.description));
check('navigate states its fixed origin, budget and contained redirects',
  /same scheme, host and port/.test(navigate.description) && /20 per session/.test(navigate.description) && /contained, not prevented/.test(navigate.description));
check('navigate requires a url', JSON.stringify(navigate.input_schema.required) === '["url"]');
check('the session evaluate warns that site actions are real', /not undone/.test(SESSION_PAGE_TOOLS.evaluate_in_page.description));
// Both hosts reload an on-site page in place (its current URL, hash and all)
// and go back to the start URL only after a page-away; the description must
// say so, or an agent reads "returns to where the session started" into a
// plain recovery reload.
check('the session reload_page says an on-site reload keeps the current URL',
  /CURRENT URL in place/.test(SESSION_PAGE_TOOLS.reload_page.description)
  && /hash/.test(SESSION_PAGE_TOOLS.reload_page.description)
  && /only then does it load the page the session started on/.test(SESSION_PAGE_TOOLS.reload_page.description),
  SESSION_PAGE_TOOLS.reload_page.description);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall checks passed');
