// Narrow a caught value (now `unknown` under useUnknownInCatchVariables) to a
// message string. The honest replacement for `(e as Error).message`, which
// re-asserts the exact assumption the flag exists to catch. Dependency-free so
// any module context (main, preload, renderer preloads) can import it; renderer
// page scripts (classic <script> tags, no imports) inline the same expression.
//
// The engine owns it so @shimbrowser/core imports nothing outside itself
// itself; the Shim browser re-exports it for the rest of the
// app, so there is still one implementation.
export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
