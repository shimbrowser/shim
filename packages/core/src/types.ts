// Shared domain model for the patch engine — the runtime shape of a patch
// spec and the anchor-ladder verification types. Defined
// here (a dependency-free leaf) so every engine file and every downstream
// consumer stage imports ONE source of truth. Fields are optional where the
// engine tolerates their absence at runtime; do not tighten a field to
// required unless the engine would crash without it.

// One rung of the anchor ladder. `kind` selects which of the sibling fields
// is meaningful (css/text use `value`; data-attr uses `name`+`value`; aria
// uses `role`/`label`; text may add `match`). Kept as a flat optional-field
// interface rather than a discriminated union: the engine's resolver switches
// on `kind` and reads the relevant fields, and a union forces casts at every
// spec-construction site for no safety gain here.
export type AnchorKind = 'css' | 'data-attr' | 'aria' | 'text';

export interface AnchorSpec {
  kind: AnchorKind;
  value?: string;
  name?: string;
  role?: string;
  label?: string;
  match?: 'exact' | 'contains';
}

// Plain-JSON fiber descriptor (component-id.ts). `mapped` is stamped at
// capture when sourcemap translation renamed the path (sourcemap Stage B).
export interface ComponentDescriptor {
  v?: number;
  path: string[];
  propKeys: string[];
  mapped?: boolean;
}

// Anchor-element shape snapshot (witness.ts). `v` is the hard version gate.
export interface Witness {
  v: number;
  tag: string;
  attrs?: Record<string, string>;
  textStem?: string;
  // 'visible': textStem was read from visible text only (script/style/
  // template/noscript skipped). Absent on witnesses captured before that —
  // their stem is whole textContent, and matching keeps a textContent retry
  // for them alone.
  textStemFrom?: 'visible';
  childTags?: string[];
  parentTag?: string;
  component?: ComponentDescriptor;
}

// Set witness (set-witness.ts): what every observed member of a multi-match
// rule's set shares. A separate field from `witness` so an older engine, which
// treats any `anchor.witness` as single-element, ignores it. `v` is the hard
// version gate. Engine-managed like `witness` (ENGINE_MANAGED_ANCHOR_KEYS).
export interface SetWitness {
  v: number;
  tag: string;
  attrs?: Record<string, string>;
  attrNames?: string[];
  childTags?: string[];
  parentTag?: string;
  textStem?: string;
  count: number;
  nested: boolean;
  // A CSS selector (tag + constant site data-* values) whose complete result
  // equalled the anchor's complete result at capture — the recovery query.
  identity?: string;
}

export interface Anchor {
  primary: AnchorSpec;
  fallbacks?: AnchorSpec[];
  iframe?: { kind: string; value: string };
  witness?: Witness;
  setWitness?: SetWitness;
  // Authored: the anchor is meant to match a set of elements (every row,
  // every card). The engine then never fingerprints it as one element: with
  // ≥2 members observed in the preview it captures a set witness, with one it
  // captures none (and the preview evidence says to load more items).
  cardinality?: 'many';
}

export interface MountSpec {
  strategy?: 'inline' | 'portal' | 'overlay' | 'shadow';
  align?: 'above' | 'below';
}

// Declarative node tree for the Tier-2 `inject-element` kind.
// The ROOT must carry `tag`; children may be text-only ({ text } → bare text
// node). A node with both `text` and `children` puts the text first. Lives
// here (not inject-kinds.ts) so Mutation can reference it without a cycle.
export interface InjectNode {
  tag?: string;
  text?: string;
  attrs?: Record<string, string>;
  style?: Record<string, string>;
  children?: InjectNode[];
}

// A single mutation. `kind` is the builtins plus rare
// per-patch declarative kinds, so it stays `string`; the engine narrows on it.
// The named optional fields are every field a builtin reads.
export interface Mutation {
  kind: string;
  properties?: Record<string, string>; // restyle
  handler?: string;                     // script / replace-root
  mount?: MountSpec;                     // script / replace-root
  title?: string;                       // mount-route
  pattern?: string;                     // mount-route
  from?: string;                        // redirect
  to?: string;                          // redirect
  exceptPaths?: string[];               // redirect
  position?: 'first' | 'last' | number;  // reorder
  before?: AnchorSpec;                   // reorder (relative)
  after?: AnchorSpec;                    // reorder (relative)
  layout?: 'flex' | 'grid';              // reshape
  direction?: 'row' | 'column';          // reshape
  columns?: number | string;             // reshape
  rows?: number | string;                // reshape
  gap?: string;                          // reshape
  wrap?: boolean;                        // reshape
  align?: string;                        // reshape
  justify?: string;                      // reshape
  element?: InjectNode;                  // inject-element
  html?: string;                         // inject-html
  placement?: 'before' | 'after' | 'prepend' | 'append'; // inject-* (default "after")
}

export interface Rule {
  id: string;
  anchor?: Anchor;
  mutations?: Mutation[];
  handlers?: Record<string, string>;
}

// The runtime patch spec. `priority` / `__cssPriority` / `bundleHash` are
// stamped onto the spec at runtime by the registry/preload,
// so they live here as optional rather than in a separate type.
export interface Spec {
  id: string;
  version?: number;
  match?: { hosts?: string[] };
  rules?: Rule[];
  // Optional top-level CSS blob injected wholesale for the spec (engine's
  // collectCssForSpec) — a real persistable spec field, distinct from the
  // runtime-stamped `__cssPriority` below.
  css?: string;
  settings?: unknown[];
  // Per-shim SQLite storage declaration. Loose
  // boundary like `settings` above: validated main-side
  // (the Shim browser's validateStorageDecl), opaque to the
  // engine — never read at runtime, only at commit/rebase time.
  storage?: unknown;
  // Remote database connection declarations.
  // Same loose boundary as `storage` above: validated main-side
  // (the Shim browser's validateConnectionsDecl), opaque to
  // the engine. Never carries a connection URL — that's main-only custody in
  // `shim_settings` (connections.ts), never on the spec.
  connections?: unknown;
  permissions?: string[];
  autoRepair?: boolean;
  // A distilled, human-readable statement of what this shim is for (Spec A).
  // Optional + back-compat: absent = today's behavior. Travels on export.
  intent?: string;
  // Global shims: marks this spec as a shared
  // identity with per-host rule implementations.
  // Optional + back-compat: absent = a normal, single-host shim — `true`
  // is the sole discriminator, never inferred from other fields.
  global?: boolean;
  // Auto mode: a per-host impl promoted to be the
  // shim's shared DEFAULT, applied on every host (the "runs everywhere"
  // opt-in). Optional + back-compat: absent = today's behavior — no
  // default, every host starts dormant until adopted.
  default?: { rules: Rule[]; handlers?: Record<string, string> };
  // Auto mode: the shared code-space — name → function source, injected
  // into every host impl as `api.shared`. Optional + back-compat: absent =
  // today's behavior, no shared handler namespace.
  sharedHandlers?: Record<string, string>;
  // Auto mode: per-shim toggle to headlessly auto-adopt each new domain
  // (global-shim-only). Optional + back-compat: absent = today's
  // behavior — adoption stays manual (the "learn this site" prompt).
  // `true` is the sole discriminator, never inferred from other fields.
  autoMode?: boolean;
  bundleHash?: string;
  priority?: number;
  __cssPriority?: number;
  /** Marks the single canonical per-host shim that the element picker appends hides to. */
  elementHides?: boolean;
}
