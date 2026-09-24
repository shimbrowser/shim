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
