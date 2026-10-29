// The worker's end of the bridge: the native messaging port to `shim bridge`
// (packages/mcp), held while the "let coding agents author here" setting is on.
// Chrome frames the messages, so what arrives here is the JSON the bridge
// sent: a request (whole, or in chunks the assembler joins), or an abort.
// Each request is answered by the route handler and the answer posted back
// by id. The port is the one way a route request reaches the worker.
//
//   - On connect the worker greets the bridge with its version.
//   - A disconnect (the bridge gone, Chrome refusing the host) runs the
//     shutdown the worker gives it (every session ended, every remembered
//     consent forgotten), then reconnects with backoff while the setting
//     stays on; turning the setting off runs the shutdown and disconnects.
//   - Pure enough to pin: Chrome's port is injected.

import { RequestAssembler, isAbort, type BridgeRequest, type ExtensionToHost } from './bridge-frames';

export const HOST_NAME = 'com.shimbrowser.bridge';
export const RECONNECT_MS = [1000, 3000, 10_000, 30_000];

export interface PortLike {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(cb: (message: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
  /** Chrome's reason for a disconnect, when it has one. */
  lastError?(): string | null;
}

export interface BridgePortDeps {
  connect(hostName: string): PortLike;
  handle(req: BridgeRequest, signal: AbortSignal): Promise<{ status: number; body: Record<string, unknown> }>;
  /** Every session ended, every remembered consent forgotten. */
  shutdown(reason: string): Promise<void>;
  version: string;
  log(line: string): void;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(h: unknown): void;
}

export interface BridgePort {
  /** Start holding a port (the setting turned on, or the worker booting with it on). */
  enable(): void;
  /** Stop: shutdown, then disconnect; no reconnect. */
  disable(): Promise<void>;
  connected(): boolean;
  lastError(): string | null;
}

export function createBridgePort(deps: BridgePortDeps): BridgePort {
  const setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let enabled = false;
  let port: PortLike | null = null;
  let attempt = 0;
  let timer: unknown = null;
  let error: string | null = null;
  let generation = 0;

  function connectNow(): void {
    if (!enabled || port) return;
    const gen = ++generation;
    const assembler = new RequestAssembler();
    const inFlight = new Map<string, AbortController>();
    let p: PortLike;
    try {
      p = deps.connect(HOST_NAME);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      schedule();
      return;
    }
    port = p;
    const post = (message: ExtensionToHost): void => {
      if (port !== p) return;
      try { p.postMessage(message); } catch (e) { deps.log(`[shim] bridge post failed: ${e instanceof Error ? e.message : String(e)}`); }
    };
    p.onMessage.addListener((message) => {
      if (port !== p) return;
      if (isAbort(message)) {
        inFlight.get(message.id)?.abort();
        assembler.drop(message.id);
        return;
      }
      const req = assembler.take(message);
      if (!req) return;
      const controller = new AbortController();
      inFlight.set(req.id, controller);
      void deps.handle(req, controller.signal).then(
        (out) => { inFlight.delete(req.id); post({ id: req.id, status: out.status, body: out.body }); },
        (e: unknown) => { inFlight.delete(req.id); post({ id: req.id, status: 500, body: { ok: false, error: 'internal-error', detail: e instanceof Error ? e.message : String(e) } }); },
      );
    });
    p.onDisconnect.addListener(() => {
      if (port !== p) return;
      port = null;
      const why = p.lastError?.() ?? null;
      error = why;
      for (const c of inFlight.values()) c.abort();
      inFlight.clear();
      deps.log(`[shim] bridge disconnected${why ? `: ${why}` : ''}`);
      void deps.shutdown(why ? `the bridge disconnected: ${why}` : 'the bridge disconnected').finally(() => {
        if (enabled && generation === gen) schedule();
      });
    });
    error = null;
    attempt = 0;
    post({ hello: true, version: deps.version });
    deps.log('[shim] bridge connected');
  }

  function schedule(): void {
    if (!enabled || timer !== null) return;
    const wait = RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)] ?? 30_000;
    attempt += 1;
    timer = setT(() => { timer = null; connectNow(); }, wait);
  }

  return {
    enable() {
      if (enabled) return;
      enabled = true;
      attempt = 0;
      connectNow();
    },
    async disable() {
      if (!enabled) return;
      enabled = false;
      generation += 1;
      if (timer !== null) { clearT(timer); timer = null; }
      const p = port;
      port = null;
      await deps.shutdown('the bridge was turned off');
      try { p?.disconnect(); } catch { /* already gone */ }
      error = null;
    },
    connected: () => port !== null,
    lastError: () => error,
  };
}
