// The attach card's window: the worker owns its lifetime. One window while
// requests wait, closed a moment after the last is answered, a fresh one for
// the next. Serialized, so two rapid changes never open two windows or race a
// close against an open.
//
// The window outlives the worker and the requests do not, so its id is kept
// where the next worker finds it (chrome.storage.session, as long as window
// ids mean anything: both end with the browser). A worker that went with the
// card open, or in the moment before closing it, closes it on its next boot.
// Chrome's calls are injected, so a harness drives every path.

export interface AttachWindowDeps {
  open(): Promise<number | null>;
  /** Rejects when the window is gone. */
  check(id: number): Promise<unknown>;
  close(id: number): Promise<unknown>;
  load(): Promise<unknown>;
  save(id: number | null): Promise<unknown>;
  /** How many requests wait now. */
  waiting(): number;
  log(message: string, err: unknown): void;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(h: unknown): void;
}

export interface AttachWindow {
  /** Brings the window in line with `waiting` requests. */
  sync(waiting: number): void;
  /** Chrome says a window closed. */
  removed(id: number): void;
  /** Resolves once everything asked so far has run. */
  idle(): Promise<void>;
}

export const CARD_CLOSE_GRACE_MS = 1200;

export function createAttachWindow(deps: AttachWindowDeps): AttachWindow {
  const setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let windowId: number | null = null;
  let closeTimer: unknown = null;

  function remember(id: number | null): Promise<unknown> {
    windowId = id;
    return deps.save(id).catch(() => undefined);
  }

  let work: Promise<void> = deps.load().then((stored) => {
    if (typeof stored === 'number' && Number.isInteger(stored)) windowId = stored;
  }, () => undefined);

  function run(step: () => Promise<void>): void {
    work = work.then(step).catch((e: unknown) => { deps.log('[shim] the attach card', e); });
  }

  return {
    sync(waiting) {
      run(async () => {
        if (waiting > 0) {
          if (closeTimer !== null) { clearT(closeTimer); closeTimer = null; }
          if (windowId !== null) {
            try { await deps.check(windowId); return; } catch { await remember(null); }
          }
          try {
            await remember(await deps.open());
          } catch (e) {
            deps.log('[shim] could not open the attach card', e);
          }
        } else if (windowId !== null && closeTimer === null) {
          const id = windowId;
          closeTimer = setT(() => {
            closeTimer = null;
            if (windowId === id && deps.waiting() === 0) {
              void remember(null);
              void deps.close(id).catch(() => undefined);
            }
          }, CARD_CLOSE_GRACE_MS);
        }
      });
    },
    removed(id) {
      run(async () => { if (id === windowId) await remember(null); });
    },
    idle: () => work,
  };
}
