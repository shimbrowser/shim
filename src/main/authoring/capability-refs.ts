// src/main/authoring/capability-refs.ts — source-text scans for capability
// calls in authored code, shared by shim spec-lint (rule handlers) and the
// composition emit lint (composition script files) so both warn on exactly
// the same shapes.
//
// Heuristics, not parses: a match inside a comment or string literal is a
// false positive, and a call with a non-literal argument (a variable, a
// template expression) is not matched at all. Callers therefore only ever
// WARN on these, never reject.

const API_AI_RE = /\bapi\s*\.\s*ai\b/;

// `api.db.connection("<name>")` / `('<name>')` — captures the literal name.
const API_DB_CONNECTION_RE = /\bapi\s*\.\s*db\s*\.\s*connection\s*\(\s*(['"])((?:(?!\1).)*)\1\s*\)/g;

// `api.fetch("<host>", …)` / `('<host>', …)` / `(`<host>`, …)` — captures a
// literal host (a template literal only when it has no substitution).
const API_FETCH_HOST_RE = /\bapi\s*\.\s*fetch\s*\(\s*(['"`])((?:(?!\1)[^$\\\n])*)\1\s*[,)]/g;

// Every literal host passed as api.fetch's first argument, in source order,
// repeats included.
export function apiFetchHosts(src: string): string[] {
  const hosts: string[] = [];
  for (const match of src.matchAll(API_FETCH_HOST_RE)) {
    const host = match[2] ?? '';
    if (host) hosts.push(host);
  }
  return hosts;
}

// Whether `host` appears in the source as a whole string literal — an
// api.fetch argument, or a constant the code passes along.
export function referencesHostLiteral(src: string, host: string): boolean {
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(['"\`])${escaped}\\1`).test(src);
}

export function referencesApiAi(src: string): boolean {
  return API_AI_RE.test(src);
}

// Every literal connection name passed to api.db.connection(...), in source
// order, repeats included (one entry per call site).
export function apiDbConnectionNames(src: string): string[] {
  const names: string[] = [];
  for (const match of src.matchAll(API_DB_CONNECTION_RE)) {
    const name = match[2] ?? '';
    if (name) names.push(name);
  }
  return names;
}
