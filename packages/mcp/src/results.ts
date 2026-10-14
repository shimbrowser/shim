// Turning Shim's tool results into MCP content (shim-core design D11, §9).
//
// A page tool answers exactly what Shim's own worker sees: a string (usually
// JSON) or content blocks in the Anthropic shape — text, and for view_page a
// base64 image. MCP wants { type: 'text', text } and { type: 'image', data,
// mimeType }.
//
// Claude Code caps one tool result at MAX_MCP_OUTPUT_TOKENS (25,000 by
// default) and images count against it. Shim already downscales a full
// viewport to 1280px wide; a crop stays at native resolution, so a large
// crop on a retina screen can be big. fitToBudget estimates each block
// (text ≈ 4 characters a token, an image ≈ width × height / 750 from its
// header) and, over budget, truncates text and replaces an image with a note
// telling the agent to crop — never sending a result Claude Code would drop.

export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export const DEFAULT_MAX_OUTPUT_TOKENS = 25_000;
// Headroom for the result's framing and our own estimate's error.
const BUDGET_SHARE = 0.9;
const CHARS_PER_TOKEN = 4;
const PIXELS_PER_TOKEN = 750;

export function maxOutputTokens(env: Record<string, string | undefined>): number {
  const raw = Number(env.MAX_MCP_OUTPUT_TOKENS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_OUTPUT_TOKENS;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Shim's tool_result content (string or Anthropic blocks) as MCP content. */
export function toMcpContent(result: unknown): McpContent[] {
  if (typeof result === 'string') return [{ type: 'text', text: result }];
  if (!Array.isArray(result)) return [{ type: 'text', text: JSON.stringify(result ?? null) }];
  const out: McpContent[] = [];
  for (const block of result as unknown[]) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text });
    } else if (block.type === 'image' && isRecord(block.source) && typeof block.source.data === 'string') {
      const mimeType = typeof block.source.media_type === 'string' ? block.source.media_type : 'image/png';
      out.push({ type: 'image', data: block.source.data, mimeType });
    }
  }
  return out.length ? out : [{ type: 'text', text: '(empty result)' }];
}

function base64Head(data: string, bytes: number): Uint8Array {
  const chars = Math.ceil(bytes / 3) * 4;
  return new Uint8Array(Buffer.from(data.slice(0, chars), 'base64'));
}

function u16(b: Uint8Array, i: number): number {
  return ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
}

function u32(b: Uint8Array, i: number): number {
  return (((b[i] ?? 0) << 24) >>> 0) + ((b[i + 1] ?? 0) << 16) + ((b[i + 2] ?? 0) << 8) + (b[i + 3] ?? 0);
}

/** Width and height from a PNG or JPEG header, or null. */
export function imageSize(data: string): { width: number; height: number } | null {
  const head = base64Head(data, 32);
  // PNG: signature, then the IHDR chunk's width and height.
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    return { width: u32(head, 16), height: u32(head, 20) };
  }
  if (head[0] !== 0xff || head[1] !== 0xd8) return null;
  // JPEG: walk the segments to the first start-of-frame. Headers are small;
  // 64KB covers any real one.
  const b = base64Head(data, 65_536);
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: u16(b, i + 7), height: u16(b, i + 5) };
    }
    i += 2 + u16(b, i + 2);
  }
  return null;
}

export function estimateTokens(block: McpContent): number {
  if (block.type === 'text') return Math.ceil(block.text.length / CHARS_PER_TOKEN);
  const size = imageSize(block.data);
  // Unknown format: assume the base64 itself is what is counted.
  if (!size) return Math.ceil(block.data.length / CHARS_PER_TOKEN);
  return Math.ceil((size.width * size.height) / PIXELS_PER_TOKEN);
}

/** The content, cut down to fit `maxTokens` (in order; later blocks give way first). */
export function fitToBudget(content: McpContent[], maxTokens: number): McpContent[] {
  let left = Math.floor(maxTokens * BUDGET_SHARE);
  const out: McpContent[] = [];
  for (const block of content) {
    const cost = estimateTokens(block);
    if (cost <= left) {
      out.push(block);
      left -= cost;
      continue;
    }
    if (block.type === 'image') {
      const size = imageSize(block.data);
      const dims = size ? ` (${size.width}×${size.height})` : '';
      const note = `[screenshot${dims} left out: it would exceed the ${maxTokens}-token tool-result limit. ` +
        'Call view_page with a `selector` for a smaller crop, or raise MAX_MCP_OUTPUT_TOKENS.]';
      out.push({ type: 'text', text: note });
      left -= estimateTokens({ type: 'text', text: note });
      continue;
    }
    const keep = Math.max(0, left * CHARS_PER_TOKEN - 120);
    const text = `${block.text.slice(0, keep)}\n[… ${block.text.length - keep} more characters cut to fit the tool-result limit]`;
    out.push({ type: 'text', text });
    left -= estimateTokens({ type: 'text', text });
  }
  return out;
}

/** One text, cut down to fit `maxTokens` the way fitToBudget cuts a text block. */
export function fitText(text: string, maxTokens: number): string {
  return fitToBudget([{ type: 'text', text }], maxTokens).map((block) => (block.type === 'text' ? block.text : '')).join('');
}
