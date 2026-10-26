// @shimbrowser/core — the package's root entry.
//
// The engine applies a declarative patch spec to any page with a DOM: hand
// `run(spec, api)` a spec and an object satisfying `CoreApi` and it resolves
// anchors, applies mutations and reports rule status through `api.reportEvent`.
// It imports no Node builtin and no host code, so the
// same source runs in the Shim browser's preload and, bundled for the browser
// platform (`@shimbrowser/core/page`), in any page a driver injects it into.
//
// This root re-exports the page-side runtime surface. Every module is also
// reachable on its own subpath (`@shimbrowser/core/<module>`), which is how
// the Shim browser consumes it today.

export { run, isShimOwnedElement, outputOwnerOf } from './engine';
export {
  resolveAll, resolveAllWithSource, suggestAnchorFor, suggestAnchorLadder,
  witnessRecover, witnessRecoverDetail,
} from './anchors';
export { buildWitness, matchWitness, WITNESS_VERSION } from './witness';
export {
  COMPONENT_ID_VERSION, buildHelperSrc, componentScore, matchComponent, translateComponent,
} from './component-id';
export { computeDeployId, deployIdForDocument, sameRegistrableDomain } from './deploy-id';
export { sha256Hex } from './sha256';
export { matcher, matchPath, normalizePath } from './route-match';
export { hostMatches } from './host-match';
export { createFetchBudget } from './fetch-budget';

export type {
  AnchorKind, AnchorSpec, ComponentDescriptor, Witness, Anchor, MountSpec, InjectNode,
  Mutation, Rule, Spec,
} from './types';
export type {
  CoreApi, HostApiMembers, MountCleanup, CoreHandlerApi, RouteMatch, RouteChangeRegistrar,
  CoreRouteMountApi,
} from './api';
export type { FetchBudget, FetchBudgetOpts, FetchBudgetTake } from './fetch-budget';
export type {
  PageHost, PageHostCapabilities, PageHostApiMember, PageWorld, PageRect, ScreenshotOptions,
  PageScreenshot, ScreenshotResult, PreviewRule, PageRuntimeEvent, PageConsoleMessage,
  PageLoadOutcome, LoadWaitOptions, PageInspection, Unsubscribe,
} from './page-host';
