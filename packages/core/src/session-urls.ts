// The top-frame URLs one session's tab committed, kept in memory for the
// session's life and bounded: what the session's evidence about `match.paths`
// is judged against (path-evidence.ts). Only what the session itself saw, so a
// page-steered agent learns nothing it could not read off its own tab; nothing
// here is stored or handed to anything outside the session.
//
// A full load and an in-page move are told apart, because scope is decided
// once per document (D18): the document's URL changes only on a full load,
// while the shown URL follows every move. An in-page move is also a hop, a
// pair of URLs a path list can end up putting on different sides.
import { PATH_COVERAGE_LIMITS, type Hop } from './path-coverage';

export const SESSION_URL_LIMITS = {
  // Distinct URLs kept; past it the oldest goes (the first stays).
  urls: 100,
  hops: PATH_COVERAGE_LIMITS.hops,
  // A longer URL is not kept: no path list is judged against one (the matcher
  // refuses a subject past its own, smaller, limit).
  urlChars: 4096,
} as const;

export interface SessionUrlLog {
  /**
   * The page the session began on, and the URL its document committed at when
   * the host knows it. A tab already moved in-page shows a URL its document
   * didn't load at, so an unknown document URL stays unknown (null), never the
   * shown one.
   */
  start(url: string, documentUrl?: string | null): void;
  /** A top-frame commit: a full load (`inPage` false) or an in-page move. */
  committed(url: string, inPage: boolean): void;
  /** The URL the current document committed at, or null before any. */
  documentUrl(): string | null;
  urls(): string[];
  hops(): Hop[];
}

function keepable(url: string): boolean {
  if (url.length > SESSION_URL_LIMITS.urlChars) return false;
  try {
    const u = new URL(url);
    // The pages a session may be attached to: the web, and the browser's own
    // pages where it lets a session work on them. The host's own guard decides
    // which of those a log is fed.
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'shim:';
  } catch {
    return false;
  }
}

export function createSessionUrlLog(): SessionUrlLog {
  let document: string | null = null;
  let shown: string | null = null;
  const urls = new Map<string, true>();
  const hops = new Map<string, Hop>();

  function remember(url: string): void {
    if (urls.has(url)) return;
    urls.set(url, true);
    if (urls.size > SESSION_URL_LIMITS.urls) {
      const keys = urls.keys();
      keys.next(); // the first stays
      const oldest = keys.next();
      if (!oldest.done) urls.delete(oldest.value);
    }
  }

  return {
    start(url, documentUrl = url) {
      if (!keepable(url)) return;
      document = documentUrl !== null && keepable(documentUrl) ? documentUrl : null;
      shown = url;
      remember(url);
      if (document !== null) remember(document);
    },
    committed(url, inPage) {
      if (!keepable(url)) {
        // A replacement that can't be recorded leaves no known document.
        if (!inPage) { document = null; shown = null; }
        return;
      }
      if (inPage) {
        if (shown !== null && shown !== url) {
          const key = `${shown}\n${url}`;
          if (!hops.has(key)) {
            hops.set(key, { from: shown, to: url });
            if (hops.size > SESSION_URL_LIMITS.hops) {
              const oldest = hops.keys().next();
              if (!oldest.done) hops.delete(oldest.value);
            }
          }
        }
      } else {
        document = url;
      }
      shown = url;
      remember(url);
    },
    documentUrl: () => document,
    urls: () => [...urls.keys()],
    hops: () => [...hops.values()],
  };
}
