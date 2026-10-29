// How the extension's own pages (settings, install review) word a placed
// secret's grant: where the value goes, exactly how, and what approving asks
// Chrome for. Plain text only; the shim's own words never come through here.

import type { GrantView } from './credential-grants';

/** The placement and format in one phrase: `the Authorization header, as "Bearer {}"`. */
export function placementText(g: Pick<GrantView, 'placement' | 'format'>): string {
  const as = g.format === '{}' ? '' : `, as "${g.format}" ({} is the value)`;
  return 'header' in g.placement
    ? `the ${g.placement.header} header${as}`
    : `the web-address parameter "${g.placement.query}"${as}`;
}

/** What approving asks Chrome for, and when it goes back. */
export function accessText(g: Pick<GrantView, 'origin'>): string {
  return `Approving also asks Chrome for access to ${g.origin}, so Shim for Chrome can read the service's answers. `
    + 'No shim runs there because of it, and the access goes back when you revoke the last approval that needs it.';
}
