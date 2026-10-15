// Pure delta application: an authoring turn's ops
// (`emit_shim_delta`'s payload) applied to a spec. No storage,
// no validation — the browser's commit path
// validates the result before anything is written, and the working-copy
// differ (working-copy-diff.ts) produces these same ops from a shim folder.

import type { Spec, Rule } from './types';
import { normalizeIntent } from './intent';

// One entry in an authoring turn's ops list (`emit_shim_delta`'s payload).
// Flat optional-field shape — mirrors AnchorSpec in
// types.ts — rather than a discriminated union: applyDelta
// switches on `op` and reads only the relevant field, and every op crosses
// an untyped boundary (an LLM's tool input, or a working copy) on its way
// in, so a stricter union would only force casts here for no safety
// gain. `rule` stays optional (not required on 'add-rule'/'update-rule')
// so a malformed op doesn't need a type-level lie — the real safety net is
// the host's commit-time validation (the browser's assertHandlersBound +
// spec-lint), same as before typing.
export interface DeltaOp {
  op?: string;
  rule?: Rule;
  ruleId?: string;
  name?: string;
  edits?: { find: string; replace: string; replaceAll?: boolean }[];
  settings?: unknown[];
  permissions?: string[];
  intent?: string;
  // Per-shim SQLite declaration: the whole
  // `spec.storage` value, replaced wholesale by `set-storage`. Deliberately
  // `unknown` — the same loose shape `Spec.storage` carries, validated by
  // shim-db/schema's validateStorageDecl at commit time rather than typed
  // structurally here (every op crosses an untyped LLM boundary on its way
  // in, so the runtime validator is the real gate).
  storage?: unknown;
  // Remote database connection declarations:
  // the whole `spec.connections` value, replaced wholesale by
  // `set-connections` — same replace-wholesale contract as `storage` above,
  // validated by shim-db/connections's validateConnectionsDecl at commit
  // time rather than typed structurally here.
  connections?: unknown;
  // Auto mode: raw function-expression source for a
  // shared handler. Carried by `set-shared-handler` (upsert into
  // `spec.sharedHandlers`); `edit-shared-handler` is resolved to a
  // `set-shared-handler` carrying the full edited source upstream
  // (the browser's handler-edits.ts), so applyDelta only ever sees `set-shared-handler`.
  source?: string;
}

// Apply a spec delta: rule ops (add-rule / remove-rule / update-rule) and the
// replace-wholesale declaration ops (set-settings / set-permissions /
// set-intent / set-storage / set-connections), plus the shared code-space
// upserts. Returns a new spec; the input is never mutated.
export function applyDelta(spec: Spec, ops: DeltaOp[] | undefined): Spec {
  const rules = [...(spec.rules || [])];
  let settings = spec.settings;
  let settingsTouched = false;
  let permissions = spec.permissions;
  let permissionsTouched = false;
  let intent = spec.intent;
  let intentTouched = false;
  let sharedHandlers = spec.sharedHandlers;
  let sharedHandlersTouched = false;
  let storage = spec.storage;
  let storageTouched = false;
  let connections = spec.connections;
  let connectionsTouched = false;
  for (const op of ops || []) {
    if (op.op === 'add-rule') {
      // `rule` is only optional at the type level to tolerate a malformed
      // op without a type-level lie (see DeltaOp) — the authoring contract
      // guarantees it accompanies 'add-rule'. Cast, not a runtime guard:
      // pushing whatever was given (including undefined on a malformed op)
      // matches the exact pre-typing behavior; commit-time validation is
      // the real safety net.
      rules.push(op.rule as Rule);
    } else if (op.op === 'remove-rule') {
      const idx = rules.findIndex((r) => r.id === op.ruleId);
      if (idx >= 0) rules.splice(idx, 1);
    } else if (op.op === 'update-rule' && op.rule) {
      const rule = op.rule;
      const idx = rules.findIndex((r) => r.id === rule.id);
      if (idx >= 0) rules[idx] = rule;
      else rules.push(rule);
    } else if (op.op === 'set-settings') {
      // Replace the whole settings DECLARATION (the schema). Values live in
      // the shim_settings table, never on the spec — so this only declares
      // which fields the shim needs, never carries a user's actual value.
      settings = Array.isArray(op.settings) ? op.settings : [];
      settingsTouched = true;
    } else if (op.op === 'set-permissions') {
      // Replace the whole permissions DECLARATION. The user's allow/deny
      // decisions live in the shim_permissions table, never on the spec —
      // declaring a permission never grants it.
      permissions = Array.isArray(op.permissions) ? op.permissions : [];
      permissionsTouched = true;
    } else if (op.op === 'set-intent') {
      // Replace the shim's intent — a distilled statement of purpose (Spec A).
      // Free prose: normalizeIntent clears a non-string/empty value and
      // truncates an over-long one; it never throws.
      intent = normalizeIntent(op.intent);
      intentTouched = true;
    } else if (op.op === 'set-storage') {
      // Replace the whole storage DECLARATION (the shim's table set) — the
      // exact same replace-wholesale contract as set-settings above, and the
      // same schema-travels/data-doesn't split: this only declares which
      // tables exist, never a row. The rows live in the shim's own on-disk
      // SQLite database (shim-db/transport-sqlite), never on the spec.
      // Carried through un-normalized: shim-db/schema's validateStorageDecl
      // (below, at every commit/validate site) is what rejects a malformed
      // declaration, so a bad value fails loudly instead of being silently
      // coerced into something the model never wrote.
      storage = op.storage;
      storageTouched = true;
    } else if (op.op === 'set-connections') {
      // Replace the whole connections DECLARATION (which remote databases
      // this shim can reach) — same replace-wholesale contract as
      // set-storage immediately above, and the same schema-travels/data-
      // doesn't split: this only declares which connections exist (name +
      // engine + optional nested table set), never a connection URL. URLs
      // live in shim_settings under a synthetic `db:<name>:url` key
      // (shim-db/connections.ts), never on the spec. Carried through
      // un-normalized: shim-db/connections's validateConnectionsDecl (below,
      // at every commit/validate site) is what rejects a malformed
      // declaration.
      connections = op.connections;
      connectionsTouched = true;
    } else if (op.op === 'set-shared-handler') {
      // Upsert one entry in the shared code-space (auto mode, design
      // 2026-08-10). `source` is RAW function-expression source (like
      // `rule.handlers` inline) — compiled into `api.shared.<name>` at boot.
      // Copy-on-first-touch so the input spec's own map is never mutated.
      if (typeof op.name === 'string' && typeof op.source === 'string') {
        if (!sharedHandlersTouched) sharedHandlers = { ...(spec.sharedHandlers || {}) };
        // `sharedHandlers` is defined here — the guard sets it above.
        (sharedHandlers as Record<string, string>)[op.name] = op.source;
        sharedHandlersTouched = true;
      }
    } else if (op.op === 'remove-shared-handler') {
      // Delete one entry from the shared code-space. The evolution contract
      // (commitGlobal) rejects removing a still-referenced function.
      if (typeof op.name === 'string') {
        if (!sharedHandlersTouched) sharedHandlers = { ...(spec.sharedHandlers || {}) };
        delete (sharedHandlers as Record<string, string>)[op.name];
        sharedHandlersTouched = true;
      }
    }
  }
  const next: Spec = { ...spec, rules };
  if (settingsTouched) next.settings = settings;
  if (permissionsTouched) next.permissions = permissions;
  if (intentTouched) next.intent = intent;
  if (sharedHandlersTouched) next.sharedHandlers = sharedHandlers;
  if (storageTouched) next.storage = storage;
  if (connectionsTouched) next.connections = connections;
  return next;
}

