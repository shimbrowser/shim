// Shared domain model for the patch engine — the runtime shape of a patch
// spec (CLAUDE.md §5) and the anchor-ladder verification types (§8). Defined
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
// capture when sourcemap translation renamed the path (§8 Stage B).
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
  childTags?: string[];
  parentTag?: string;
  component?: ComponentDescriptor;
}

export interface Anchor {
  primary: AnchorSpec;
  fallbacks?: AnchorSpec[];
  iframe?: { kind: string; value: string };
  witness?: Witness;
}

export interface MountSpec {
  strategy?: 'inline' | 'portal' | 'overlay' | 'shadow';
  align?: 'above' | 'below';
}

// Declarative node tree for the Tier-2 `inject-element` kind (CLAUDE.md §6).
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

// A single mutation. `kind` is the builtins (CLAUDE.md §6) plus rare
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
// stamped onto the spec at runtime by the registry/preload (CLAUDE.md §6 §12),
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
  permissions?: string[];
  autoRepair?: boolean;
  // A distilled, human-readable statement of what this shim is for (Spec A).
  // Optional + back-compat: absent = today's behavior. Travels on export.
  intent?: string;
  bundleHash?: string;
  priority?: number;
  __cssPriority?: number;
}
