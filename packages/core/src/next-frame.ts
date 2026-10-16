// nextFrame — run a callback once, on the next animation frame or after a
// short fallback timer, whichever comes first.
//
// The engine coalesces its MutationObserver work (a rule's re-scan, a route's
// self-heal) to one run per frame. A frame alone isn't enough: Chromium stops
// animation frames for a page it doesn't paint — a window in the background or
// behind another app, a host's hidden window — so a page that replaced its DOM
// there was never re-shimmed until it was shown again, and an agent reading
// the page meanwhile saw its outputs gone. Timers keep running in those pages
// (throttled, but they run), so the fallback timer does the work instead.
//
// In a page that paints, the frame comes within a few milliseconds and the
// timer is cancelled, so timing there is unchanged.

export const FRAME_FALLBACK_MS = 100;

// Schedules `run` and returns a cancel function. `run` is called at most once;
// cancelling after it ran does nothing.
export function nextFrame(run: () => void, fallbackMs: number = FRAME_FALLBACK_MS): () => void {
  let done = false;
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => {
    done = true;
    cancelAnimationFrame(frame);
    if (timer !== undefined) clearTimeout(timer);
  };
  const fire = (): void => {
    if (done) return;
    stop();
    run();
  };
  frame = requestAnimationFrame(fire);
  timer = setTimeout(fire, fallbackMs);
  return () => { if (!done) stop(); };
}
