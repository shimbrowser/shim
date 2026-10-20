// A host's capability contract, checked against a shim:
// anything outside what a host supports is rejected, never silently
// different. Three layers, because only declared features can be seen before
// anything runs:
//
//   preflight     preflightSpec — the declared features: mutation kinds,
//                 `anchor.iframe`, the spec-level `css` block, and the spec's
//                 settings / permissions / storage / connections
//                 declarations. Atomic: a session
//                 applies nothing and answers `unsupported` with the list.
//   source scan   scanHandlerSource / scanSpecHandlers — handler source that
//                 mentions an api member the host lacks. A heuristic warning
//                 (it can miss an aliased use and flag a comment).
//   runtime       the host's api: a member it lacks fails in the shape its
//                 callers expect and records an `unsupported-api` event —
//                 which verificationLevel turns into `partial`.
//
// Pure: no Node, no DOM.

import type { Spec, Rule } from './types';
import { fingerprintKind } from './managed-anchor';
import type { ManagedFingerprint } from './managed-anchor';
import { WITNESS_VERSION } from './witness';
import { SET_WITNESS_VERSION } from './set-witness';
import type { PageHostCapabilities, PageHostApiMember } from './page-host';
import { PAGE_HOST_API_MEMBERS } from './page-host';
import { referencedHandlerNames } from './shim-folder';
import { moduleToExpression } from './handler-source';

/** The answer a session gives a spec that declares something the host lacks. */
export const UNSUPPORTED = 'unsupported';

/** The runtime event a host's api records when a handler uses a member the host lacks. */
export const UNSUPPORTED_API_EVENT = 'unsupported-api';

/** One declared feature the host does not support. */
export interface UnsupportedFeature {
  /** The rule that declares it, or absent for a spec-level declaration. */
  ruleId?: string;
  /** `mutation-kind`, `iframe-rule`, `css`, or the declaration field (`settings`, `permissions`, `storage`, `connections`). */
  feature: string;
  /** The kind name, for a mutation kind. */
  kind?: string;
  /** One line for the agent. */
  message: string;
}

export type PreflightResult =
  | { ok: true }
  | { ok: false; error: typeof UNSUPPORTED; unsupported: UnsupportedFeature[] };

// Spec-level declarations that need a host subsystem (D15): the settings
// store, capability grants, a per-shim database, remote connections.
const DECLARATIONS = ['settings', 'permissions', 'storage', 'connections'] as const;

const DECLARATION_NEEDS: Record<(typeof DECLARATIONS)[number], { member: PageHostApiMember; what: string }> = {
  settings: { member: 'settings', what: 'per-shim settings (api.settings)' },
  // Grants are what make a declared permission usable; a host with api.ai
  // has the grant subsystem.
  permissions: { member: 'ai', what: 'capability permissions and their grants (api.ai, discovery)' },
  storage: { member: 'db', what: 'a per-shim database (api.db)' },
  connections: { member: 'db', what: 'remote database connections (api.db connection())' },
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// A declaration counts when it says something: an empty array or object is
// what "nothing declared" looks like on the wire.
function declares(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

// The engine installs any truthy `css`; whitespace alone styles nothing.
function declaresCss(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  return declares(value);
}

/**
 * Every declared feature of `spec` the host lacks, in spec order. A host
 * applies nothing from a spec that has any (D15 preflight: atomic).
 */
export function preflightSpec(spec: Spec, capabilities: PageHostCapabilities): PreflightResult {
  const unsupported: UnsupportedFeature[] = [];
  const kinds = new Set(capabilities.mutationKinds);
  const record = spec as unknown as Record<string, unknown>;
  const members = new Set<string>(capabilities.apiMembers);
  for (const field of DECLARATIONS) {
    const need = DECLARATION_NEEDS[field];
    if (!declares(record[field]) || members.has(need.member)) continue;
    unsupported.push({
      feature: field,
      message: `the shim declares "${field}", which needs ${need.what} — not available on this host`,
    });
  }
  // A whole-patch stylesheet a host doesn't install would leave every rule
  // reporting a clean apply on a page that lacks the shim's styling.
  if (!capabilities.specCss && declaresCss(record.css)) {
    unsupported.push({
      feature: 'css',
      message: 'the shim declares a spec-level "css" block, which this host does not install — move its styles into rules (restyle) or author this shim in the Shim browser',
    });
  }
  for (const rule of spec.rules || []) {
    if (!isRecord(rule)) continue;
    const ruleId = typeof rule.id === 'string' ? rule.id : '?';
    const seen = new Set<string>();
    for (const mutation of rule.mutations || []) {
      const kind = isRecord(mutation) && typeof mutation.kind === 'string' ? mutation.kind : null;
      if (kind === null || kinds.has(kind) || seen.has(kind)) continue;
      seen.add(kind);
      unsupported.push({
        ruleId,
        feature: 'mutation-kind',
        kind,
        message: `rule "${ruleId}": mutation kind "${kind}" is not supported on this host`,
      });
    }
    if (!capabilities.iframeRules && isRecord(rule.anchor) && rule.anchor.iframe !== undefined) {
      unsupported.push({
        ruleId,
        feature: 'iframe-rule',
        message: `rule "${ruleId}": anchor.iframe (a rule inside a child frame) is not supported on this host`,
      });
    }
  }
  return unsupported.length ? { ok: false, error: UNSUPPORTED, unsupported } : { ok: true };
}

/** Every api member a handler can reach that a host may lack (D15), in a stable order. */
export type ScannedApiMember = PageHostApiMember | 'bridge.forwardRule';

// `api.x`, `api?.x`, `api.storage.pack`, `api['x']`. Word-bounded on `api` so
// `myapi.fetch` doesn't count; the member must end at a word boundary so
// `api.fetchAll` doesn't either.
function memberPattern(member: string): RegExp {
  const path = member.split('.').map((part) => `(?:\\??\\.\\s*${part}|\\[\\s*['"\`]${part}['"\`]\\s*\\])`).join('\\s*');
  return new RegExp(`(?<![\\w$.])api\\s*${path}(?![\\w$])`);
}

/** The members a host lacks, given its capabilities: every api member it doesn't list, plus bridge.forwardRule without iframe rules. */
export function unsupportedApiMembers(capabilities: PageHostCapabilities): ScannedApiMember[] {
  const have = new Set<string>(capabilities.apiMembers);
  const out: ScannedApiMember[] = PAGE_HOST_API_MEMBERS.filter((m) => !have.has(m));
  if (!capabilities.iframeRules) out.push('bridge.forwardRule');
  return out;
}

/** The unsupported members one handler's source mentions (D15 source scan; a heuristic). */
export function scanHandlerSource(source: string, capabilities: PageHostCapabilities): ScannedApiMember[] {
  return unsupportedApiMembers(capabilities).filter((member) => memberPattern(member).test(source));
}

/** One handler's source-scan finding. */
export interface SourceScanFinding {
  handler: string;
  ruleIds: string[];
  members: ScannedApiMember[];
  message: string;
}

/**
 * Scan the handlers `rules` reference (their inline source, else the stored
 * module) for unsupported api members. One finding per handler that mentions
 * any, worded as an evidence warning.
 */
export function scanRuleHandlers(
  rules: readonly Rule[],
  capabilities: PageHostCapabilities,
  storedModules: Record<string, string> = {},
  refusal = 'requires-shim-browser',
): SourceScanFinding[] {
  const byHandler = new Map<string, { source: string; ruleIds: string[] }>();
  for (const rule of rules) {
    const names = new Set([...referencedHandlerNames(rule), ...Object.keys(rule.handlers || {})]);
    for (const name of names) {
      const inline = rule.handlers?.[name];
      const stored = storedModules[name];
      const source = typeof inline === 'string' ? inline : typeof stored === 'string' ? moduleToExpression(stored) : null;
      if (source === null) continue;
      const entry = byHandler.get(name);
      if (entry) entry.ruleIds.push(rule.id);
      else byHandler.set(name, { source, ruleIds: [rule.id] });
    }
  }
  const findings: SourceScanFinding[] = [];
  for (const [handler, { source, ruleIds }] of byHandler) {
    const members = scanHandlerSource(source, capabilities);
    if (!members.length) continue;
    const list = members.map((m) => `api.${m}`).join(', ');
    findings.push({
      handler,
      ruleIds,
      members,
      message: `handler "${handler}" mentions ${list}, which this host does not provide: a never-throw call ` +
        `resolves { ok: false, error: '${refusal}' }, api.settings reads as unconfigured, and an optional ` +
        'member reads as absent. A rule whose handler uses one is reported `partial`.',
    });
  }
  return findings;
}

/**
 * A rule's verification level on a host (D15): `full` only when every signal in
 * its fingerprint was checked there, `partial` when something couldn't be, and
 * `none` when the rule matched nothing (it is in the preview's `noMatch[]`), so
 * there was nothing to verify. It never says the rule looks right.
 */
export type VerificationLevel = 'full' | 'partial' | 'none';

/**
 * `none` when the rule matched nothing; otherwise `partial` when the host could
 * not check something: a handler used an api member the host lacks (an
 * `unsupported-api` event fired for the rule); the anchor carries a
 * fingerprint this engine can't read (an unknown version), or both kinds at
 * once (conflicted: it needs a recapture); the element witness carries
 * component identity and the host has none. A set witness of a known version
 * is verified per member on every host. `fingerprint` is the rule's anchor
 * (only its engine-managed fields are read).
 */
export function verificationLevel(
  fingerprint: ManagedFingerprint | undefined,
  capabilities: PageHostCapabilities,
  unsupportedApiFired: boolean,
  matchedNothing = false,
): VerificationLevel {
  if (matchedNothing) return 'none';
  if (unsupportedApiFired) return 'partial';
  const kind = fingerprintKind(fingerprint);
  if (kind === 'conflicted') return 'partial';
  const witness = fingerprint?.witness;
  if (witness && witness.v !== WITNESS_VERSION) return 'partial';
  if (!capabilities.componentIdentity && witness?.component !== undefined) return 'partial';
  const setWitness = fingerprint?.setWitness;
  if (setWitness && setWitness.v !== SET_WITNESS_VERSION) return 'partial';
  return 'full';
}
