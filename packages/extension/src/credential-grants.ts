// Credential grants in Shim for Chrome (core D17): the user's approval for a
// shim to have one of its placed secrets sent, the same rule the Shim
// browser keeps. Declaring `use` is not granting: a placed secret is sent
// only while
//
//   - its field still declares exactly the placement the user approved
//     (`binding`: origin, header or query name, format), and
//   - the shim's code is exactly what it was when they approved (`digest`,
//     core's execution manifest: spec and handler sources, minus witnesses,
//     versions and deploy hashes).
//
// Any authored change (a session's commit, a restore) leaves the grant
// suspended until the user approves again. The one change that re-binds it
// is the engine's own witness-verified rebase of an anchor, reported by the
// shim's own world, when nothing but anchors moved. Grants are approved only
// from the extension's own settings page; a session can never create or
// widen one. Pure: the worker stores the rows.

import type { Spec } from '@shimbrowser/core/types';
import { normalizeSchema, settingsSchemaProblems, type CredentialUse } from '@shimbrowser/core/settings-schema';
import { credentialUseBinding, describeCredentialUse } from '@shimbrowser/core/credential-placement';
import { executionManifestDigest, executionManifestDigestWithoutAnchors } from '@shimbrowser/core/credential-grant';
import { sha256Hex } from '@shimbrowser/core/sha256';
import { accessPatternForOrigin } from './credential-access';

export interface GrantRow {
  shimId: string;
  key: string;
  binding: string;
  digest: string;
  grantedAt: number;
}

export type GrantState = 'granted' | 'suspended' | 'none';

/** One placed secret as the settings page shows it. */
export interface GrantView {
  key: string;
  label: string;
  /** Where the value goes, in plain words (core's describeCredentialUse; Chrome's worker cannot suppress error reports). */
  description: string;
  /** The exact origin the value goes to. */
  origin: string;
  /** How it is placed: the header's name, or the web-address parameter's. */
  placement: { header: string } | { query: string };
  /** The value's format, `{}` standing for the value (`Bearer {}`). */
  format: string;
  /** The Chrome match pattern approving asks site access for (credential-access.ts). */
  access: string;
  state: GrantState;
  /** A value is stored for exactly this placement. */
  isSet: boolean;
  /**
   * What the user is shown and would approve: the placement and the code as
   * one opaque token. An approval naming another one is stale (the shim
   * changed since the page loaded) and is refused.
   */
  review: string;
}

/** The shim's secret fields that declare `use`, in declaration order; none when the declaration does not validate. */
export function placedFields(spec: Spec): Array<{ key: string; label: string; use: CredentialUse }> {
  if (settingsSchemaProblems(spec).length) return [];
  return normalizeSchema(spec).flatMap((f) => (f.type === 'secret' && f.use ? [{ key: f.key, label: f.label, use: f.use }] : []));
}

export function placedUse(spec: Spec, key: string): CredentialUse | undefined {
  return placedFields(spec).find((f) => f.key === key)?.use;
}

export function manifestDigest(spec: Spec, handlers: Record<string, string>): string {
  return executionManifestDigest(spec, handlers);
}

export function reviewToken(use: CredentialUse, digest: string): string {
  return sha256Hex(`${credentialUseBinding(use)}\n${digest}`);
}

export function grantState(row: GrantRow | undefined, use: CredentialUse, digest: string): GrantState {
  if (!row) return 'none';
  return row.binding === credentialUseBinding(use) && row.digest === digest ? 'granted' : 'suspended';
}

export function grantViews(
  shim: { spec: Spec; handlers: Record<string, string> },
  rows: ReadonlyMap<string, GrantRow>,
  setPlacements: ReadonlyMap<string, string>,
): GrantView[] {
  const digest = manifestDigest(shim.spec, shim.handlers);
  return placedFields(shim.spec).map((f) => ({
    key: f.key,
    label: f.label,
    description: describeCredentialUse(f.use),
    origin: f.use.origin,
    placement: f.use.header !== undefined ? { header: f.use.header } : { query: f.use.query },
    format: f.use.format,
    access: accessPatternForOrigin(f.use.origin) ?? '',
    state: grantState(rows.get(f.key), f.use, digest),
    isSet: setPlacements.get(f.key) === credentialUseBinding(f.use),
    review: reviewToken(f.use, digest),
  }));
}

export type ApproveCheck = { ok: true; row: Omit<GrantRow, 'grantedAt'> } | { ok: false; error: string; code?: 'stale' };

/** The grant row an approval writes, if `review` is what the shim is now. */
export function checkApproval(shim: { id: string; spec: Spec; handlers: Record<string, string> }, key: unknown, review: unknown): ApproveCheck {
  if (typeof key !== 'string' || typeof review !== 'string') return { ok: false, error: 'an approval names a key and what was reviewed' };
  const field = placedFields(shim.spec).find((f) => f.key === key);
  if (!field) return { ok: false, error: `"${key}" is not one of this shim's placed secrets` };
  const digest = manifestDigest(shim.spec, shim.handlers);
  if (review !== reviewToken(field.use, digest)) return { ok: false, error: 'the shim changed since this was shown; review it again', code: 'stale' };
  return { ok: true, row: { shimId: shim.id, key, binding: credentialUseBinding(field.use), digest } };
}

/**
 * After the engine's rebase moved an anchor: the digest a grant current for
 * `before` moves to, when nothing but anchors changed; null otherwise (the
 * grant then stays bound to the old code, suspended).
 */
export function rebindDigest(before: Spec, after: Spec, handlers: Record<string, string>): { from: string; to: string } | null {
  if (executionManifestDigestWithoutAnchors(before, handlers) !== executionManifestDigestWithoutAnchors(after, handlers)) return null;
  return { from: executionManifestDigest(before, handlers), to: executionManifestDigest(after, handlers) };
}
