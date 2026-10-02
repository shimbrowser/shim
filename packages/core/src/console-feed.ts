// Pure console buffer + formatters for the "console visibility during
// authoring" feature (CLAUDE.md §16 companion — the read_console tool and
// live rule-status feedback both build on this). No imports: this module is
// consumed by both a later Electron `console-message` listener (main
// process) and a bare-node harness, and staying import-free keeps it trivial
// to unit test and impossible to accidentally couple to Electron/DOM types.

export const RING_CAP = 200;
export const MSG_CAP = 500;
export const AUTO_BLOCK_CAP = 10;
export const READ_CHAR_CAP = 4000;

export type ConsoleLevel = 'debug' | 'info' | 'warning' | 'error';

export interface ConsoleEntry {
  level: ConsoleLevel;
  message: string;         // pre-capped to MSG_CAP
  source: string;          // sourceId (URL or handler sourceURL), may be ''
  tag: string;             // '[site]' | '[shim]' | '[shim <handlerName>]'
  ts: number;
}

export interface ConsoleFeed {
  push(e: { level: string; message: string; source: string; ts: number }): void;
  drainSinceEmit(): ConsoleEntry[];   // errors+warnings since last drain; clears the list
  ring(): ConsoleEntry[];             // last RING_CAP entries, all levels, oldest→newest
  clear(): void;                      // drops every entry (ring and since-emit)
}

// Same virtual-URL shape page-preload.ts's PATCH_HANDLER_URL_RE matches
// (committed handlers via compileBag's `filename:`, previews via the
// //# sourceURL pragma). Duplicated here because this module is pure main-
// side and page-preload is a preload; if the sourceURL shape ever changes,
// change BOTH (cross-ref comment lives on both regexes).
const HANDLER_URL_RE = /shim:\/\/patches\/(?:[^/\s]+)\/handlers\/([^/.\s]+)/;

export function tagFor(source: string, message: string): string {
  const m = HANDLER_URL_RE.exec(source) ?? HANDLER_URL_RE.exec(message);
  if (!m) return '[site]';
  return m[1] ? `[shim ${m[1]}]` : '[shim]';
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
        tag: tagFor(e.source, message),
        ts: e.ts,
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
    const key = `${e.level}|${e.source}|${e.message.slice(0, 120)}`;
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
