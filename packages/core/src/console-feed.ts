// Pure console buffer + formatters for console visibility during authoring
// (the read_console tool and the console block in every preview's evidence).
// One implementation for every host: the Shim
// browser's main process feeds it from Electron's console messages, the
// headless driver (@shimbrowser/mcp) from CDP's. No imports, so it stays
// trivial to unit test and can't couple to Electron or DOM types.

export const RING_CAP = 200;
export const MSG_CAP = 500;
export const AUTO_BLOCK_CAP = 10;
export const READ_CHAR_CAP = 4000;

export type ConsoleLevel = 'debug' | 'info' | 'warning' | 'error';

export interface ConsoleEntry {
  level: ConsoleLevel;
  message: string;         // pre-capped to MSG_CAP
  source: string;          // sourceId (URL or handler sourceURL), may be ''
  tag: string;             // '[site]' | '[shim?]' | '[shim? <handlerName>]' | '[shim]' | '[shim <handlerName>]', plus ' · frame <host>' from a sub-frame
  ts: number;
  frame?: string;          // the logging sub-frame's host; absent for the top frame
}

export interface ConsoleFeed {
  push(e: { level: string; message: string; source: string; ts: number; frame?: string; hostLike?: boolean; engineWorld?: boolean }): void;
  drainSinceEmit(): ConsoleEntry[];   // errors+warnings since last drain; clears the list
  ring(): ConsoleEntry[];             // last RING_CAP entries, all levels, oldest→newest
  clear(): void;                      // drops every entry (ring and since-emit)
}

// Same virtual-URL shape page-preload.ts's PATCH_HANDLER_URL_RE matches
// (committed handlers via compileBag's `filename:`, previews via the
// //# sourceURL pragma; the headless driver compiles under the same one).
// Duplicated here because this module is host-agnostic and page-preload is a
// preload; if the sourceURL shape ever changes, change BOTH (cross-ref
// comment lives on both regexes). Matched against a line's SOURCE only, never
// its text: any page can log the URL.
const HANDLER_URL_RE = /^shim:\/\/patches\/(?:[^/\s]+)\/handlers\/([^/.\s]+)/;

// The engine's own diagnostics (anchors, rebase, dispatch) open with this
// prefix and carry no handler URL. The page can log the same text, so a line
// that only LOOKS like Shim's own tags `[shim?]`: told apart from the site's
// ordinary output, never vouched for.
const ENGINE_PREFIX = '[shim] ';

// A frame label is a host or a scheme; bound it anyway, it lands in every line.
const FRAME_CAP = 64;

export interface TagSignals {
  /**
   * The logging sub-frame's host (absent for the top frame): a sub-frame's
   * lines are another document's — an embed on the page, often running the
   * user's shims for ITS site — so the tag says where they came from.
   */
  frame?: string;
  /**
   * The host's reading that the line's source LOOKS like its own code (its
   * preload, engine files, runtime internals). A page can forge a source with
   * a `//# sourceURL=` pragma, so it earns `[shim?]`, never `[shim]`.
   */
  hostLike?: boolean;
  /**
   * The host PROVED the line was logged in the engine's isolated world (an
   * execution context it created, which page script can't run in). The only
   * signal that earns an authoritative `[shim]` / `[shim <handler>]`.
   */
  engineWorld?: boolean;
}

// Only `engineWorld` vouches for a line. A handler URL as the source without
// it is just as forgeable as the engine prefix (`eval(code +
// '\n//# sourceURL=shim://patches/…/handlers/x.js')`), so it tags
// `[shim? x]`: told apart from the site's output, never vouched for.
export function tagFor(source: string, message: string, signals: TagSignals = {}): string {
  const m = HANDLER_URL_RE.exec(source);
  const handler = m?.[1] ? ` ${m[1]}` : '';
  const who = signals.engineWorld ? `shim${handler}`
    : m ? `shim?${handler}`
    : signals.hostLike || message.startsWith(ENGINE_PREFIX) ? 'shim?' : 'site';
  const frame = signals.frame;
  return frame ? `[${who} · frame ${frame.slice(0, FRAME_CAP)}]` : `[${who}]`;
}

function normalizeLevel(level: string): ConsoleLevel {
  if (level === 'error' || level === 'warning' || level === 'debug') return level;
  return 'info';
}

export function createConsoleFeed(): ConsoleFeed {
  const ringBuf: ConsoleEntry[] = [];
  let sinceEmit: ConsoleEntry[] = [];

  return {
    push(e) {
      const level = normalizeLevel(e.level);
      const message = e.message.length > MSG_CAP ? e.message.slice(0, MSG_CAP) : e.message;
      const entry: ConsoleEntry = {
        level,
        message,
        source: e.source,
        tag: tagFor(e.source, message, {
          ...(e.frame ? { frame: e.frame } : {}),
          hostLike: e.hostLike === true,
          engineWorld: e.engineWorld === true,
        }),
        ts: e.ts,
        ...(e.frame ? { frame: e.frame.slice(0, FRAME_CAP) } : {}),
      };
      ringBuf.push(entry);
      if (ringBuf.length > RING_CAP) ringBuf.shift();
      if (level === 'error' || level === 'warning') sinceEmit.push(entry);
    },
    drainSinceEmit() {
      const drained = sinceEmit;
      sinceEmit = [];
      return drained;
    },
    ring() {
      return ringBuf.slice();
    },
    clear() {
      ringBuf.length = 0;
      sinceEmit = [];
    },
  };
}

function formatLine(e: ConsoleEntry, count: number): string {
  const suffix = count > 1 ? ` ×${count}` : '';
  return `${e.tag} ${e.level}${suffix}: ${e.message}`;
}

export function formatAutoBlock(entries: ConsoleEntry[]): string | null {
  if (entries.length === 0) return null;

  interface Bucket { entry: ConsoleEntry; count: number; order: number }
  const buckets = new Map<string, Bucket>();
  let order = 0;
  for (const e of entries) {
    const key = `${e.level}|${e.tag}|${e.source}|${e.message.slice(0, 120)}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      buckets.set(key, { entry: e, count: 1, order: order++ });
    }
  }

  const levelRank = (lvl: ConsoleLevel): number => (lvl === 'error' ? 0 : lvl === 'warning' ? 1 : 2);
  const sorted = Array.from(buckets.values()).sort((a, b) => {
    const rankDiff = levelRank(a.entry.level) - levelRank(b.entry.level);
    if (rankDiff !== 0) return rankDiff;
    return a.order - b.order;
  });

  const shown = sorted.slice(0, AUTO_BLOCK_CAP);
  const overflow = sorted.length - shown.length;

  const lines = shown.map((b) => formatLine(b.entry, b.count));
  if (overflow > 0) lines.push(`…and ${overflow} more — use read_console`);

  return ['# Console since your last apply', ...lines].join('\n');
}

// 'level' is a MINIMUM severity filter (matches the read_console tool's
// description to the model): 'error' returns errors only, 'warning' returns
// warnings AND errors, 'all' (or omitted) returns everything. Rank order:
// debug < info < warning < error.
const LEVEL_RANK: Record<ConsoleLevel, number> = { debug: 0, info: 1, warning: 2, error: 3 };

export function formatConsoleRead(
  entries: ConsoleEntry[],
  opts: { level?: 'error' | 'warning' | 'all'; limit?: number },
): string {
  const level = opts.level ?? 'all';
  const filtered = level === 'all'
    ? entries.slice()
    : entries.filter((e) => LEVEL_RANK[e.level] >= LEVEL_RANK[level]);

  const limited = opts.limit !== undefined && opts.limit >= 0
    ? filtered.slice(Math.max(0, filtered.length - opts.limit))
    : filtered;

  const lines = limited.map((e) => formatLine(e, 1));

  const full = lines.join('\n');
  if (full.length <= READ_CHAR_CAP) return full;

  // Single pass: walk newest→oldest accumulating lines while the running
  // total (lines kept so far + the marker, joined by '\n') stays within the
  // cap. The newest line always survives, even if the cap is still exceeded
  // by the marker + that one line alone.
  const marker = '[… older lines truncated …]';
  let kept = 1; // count of newest lines kept, from the end of `lines`
  let total = marker.length + 1 + (lines[lines.length - 1] ?? '').length;
  for (let i = lines.length - 2; i >= 0; i--) {
    const line = lines[i] ?? '';
    const next = total + 1 + line.length;
    if (next > READ_CHAR_CAP) break;
    total = next;
    kept++;
  }
  return [marker, ...lines.slice(lines.length - kept)].join('\n');
}
