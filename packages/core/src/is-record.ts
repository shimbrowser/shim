// A plain (non-null, non-array) object, narrowed for field-by-field checks at a
// dynamic boundary (persisted JSON, IPC payloads, model tool input). The one
// definition: a local copy fails lint.
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
