// Narrow a value the code knows is present but the type system can't prove.
//
// Under `noUncheckedIndexedAccess`, every `arr[i]` / `record[key]` types as
// `T | undefined`. Most such accesses should be RESTRUCTURED so the value can't
// be undefined (iterate with `for...of` instead of an index; destructure with a
// guard: `const [first] = arr; if (!first) return`) or handled with a real
// null check where undefined can genuinely occur.
//
// `must` is only for the irreducible remainder — an access that is provably
// in-bounds but that the type system can't see and that has no natural
// restructuring (a regex capture group the pattern guarantees, `split(x)[0]`
// which is never empty). It returns the value non-null, and THROWS with context
// if the "impossible" ever happens — so a future change that violates the
// assumption fails loudly at the exact spot instead of leaking `undefined`
// downstream. Prefer it over a bare `!` non-null assertion, which fails silently.
export function must<T>(value: T | null | undefined, what: string): T {
  if (value == null) {
    throw new Error(`must(${what}): expected a value but got ${value === null ? 'null' : 'undefined'}`);
  }
  return value;
}
