// Who sent a message to the worker, from the sender Chrome attaches, never
// from the message body. Two kinds of sender exist: the extension's own
// pages (the popup, the install page), which may change what is installed,
// and the page runtime on a site, which may only ask about and store for
// the shims that run on that very site. A message is answered only on the
// kind of sender its type expects. Pure, so a harness pins it.

export type SenderContext =
  /** One of the extension's own pages. */
  | { kind: 'page' }
  /** The page runtime, on a site the content script was registered for. */
  | { kind: 'content'; hostname: string; port: string; origin: string; pathname: string; tabId?: number }
  | { kind: 'unknown' };

export interface SenderLike {
  id?: string;
  url?: string;
  tab?: unknown;
}

/**
 * `extensionId` is this extension's; `extensionBase` is `chrome.runtime.getURL('')`,
 * the `chrome-extension://<id>/` prefix every page of ours has.
 */
export function senderContext(sender: SenderLike | undefined, extensionId: string, extensionBase: string): SenderContext {
  if (!sender || sender.id !== extensionId || typeof sender.url !== 'string') return { kind: 'unknown' };
  if (sender.url.startsWith(extensionBase)) return { kind: 'page' };
  let url: URL;
  try {
    url = new URL(sender.url);
  } catch {
    return { kind: 'unknown' };
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !sender.tab) return { kind: 'unknown' };
  const tab = sender.tab as { id?: unknown };
  return { kind: 'content', hostname: url.hostname, port: url.port, origin: url.origin, pathname: url.pathname, ...(typeof tab.id === 'number' ? { tabId: tab.id } : {}) };
}

/** Message types the extension's own pages may send. */
export const PAGE_MESSAGES: ReadonlySet<string> = new Set([
  'mode', 'shims.list', 'shims.setEnabled', 'shims.uninstall', 'shims.export', 'shims.versions', 'shims.restore', 'install.commit',
  'bridge.status', 'bridge.setEnabled', 'attach.pending', 'attach.answer', 'settings.fields', 'settings.set', 'settings.clear',
]);
/** Message types the page runtime may send. */
export const CONTENT_MESSAGES: ReadonlySet<string> = new Set(['bundle', 'storage', 'settings', 'fetch', 'event']);

export function allowedFrom(type: string, context: SenderContext): boolean {
  if (context.kind === 'page') return PAGE_MESSAGES.has(type);
  if (context.kind === 'content') return CONTENT_MESSAGES.has(type);
  return false;
}
