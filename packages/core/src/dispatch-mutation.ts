// Invokes one mutation against a resolved anchor and returns the DOM nodes the
// handler produced. This is the per-mutation-kind switch (the built-in kinds
// plus custom registry kinds); applyRule's mountOn calls it once per mutation
// on each matched element. Handlers enable self-healing by returning the root
// node(s) they mounted; handlers that return nothing opt out.

import { compileReorderCss, compileReshapeCss } from './layout-kinds';
import { buildElement, parseInjectHtml, resolvePlacement } from './inject-kinds';
import {
  injectTier1Rule, tagElement, cssBodyFromProps, cssPriorityOf,
  injectReplaceRootRule, tagReplaceRootAnchor, tagMountedNode,
} from './css-sheets';
import { normalizeOutputs, trimStackForEvent } from './engine-internal';
import type { MutationRegistry, HandlerMap } from './engine-internal';
import type { Mutation, Rule, Spec } from './types';
import type { CoreAnchoredHandlerApi } from './api';
import { errMessage } from './error';

// Apply-time strip feedback for inject-html: when the strip pass removed
// active content, the fact rides the rule-status `note` field so the authoring
// loop tells the model its onclick/script never shipped. Keyed spec/rule; set
// here at mount, read + cleared by the rule's status reporter + teardown
// (rule-status.ts / apply-rule.ts). Module-level because dispatch is the writer
// and the reporter/teardown are the readers.
export const injectStripNotes = new Map<string, string>();

export function dispatchMutation(
  el: Element,
  mut: Mutation,
  rule: Rule,
  spec: Spec,
  api: CoreAnchoredHandlerApi,
  mutations: MutationRegistry,
  handlers: HandlerMap,
): Promise<Node[]> {
  // Emit a handler-error event into the authoring channel. Handler throws are
  // caught by the wrapper below (so a buggy handler can't take down the whole
  // engine), which means they never bubble to window.error — we'd only see
  // them in the console without this. Reporting from here is the primary path
  // for synchronous mount-time throws + initial promise rejections; the
  // page-preload's window.error / unhandled-rejection listeners stay the
  // backstop for async throws that escape the wrapper (e.g. event listeners
  // installed by a successful mount that throw later).
  const reportError = (handlerName: string, err: unknown) => {
    if (typeof api.reportEvent !== 'function') return;
    api.reportEvent('handler-error', {
      specId: spec.id,
      handlerName: handlerName || '(anonymous)',
      ruleId: rule.id,
      message: errMessage(err),
      stack: trimStackForEvent(err instanceof Error ? err.stack || '' : ''),
    });
  };

  const safe = (label: string, handlerName: string | null | undefined, work: () => unknown): Promise<Node[]> => {
    try {
      return Promise.resolve(work()).then(normalizeOutputs, (err) => {
        console.error(`[shim] ${label} failed`, err);
        if (handlerName) reportError(handlerName, err);
        return [];
      });
    } catch (err) {
      console.error(`[shim] ${label} failed`, err);
      if (handlerName) reportError(handlerName, err);
      return Promise.resolve([]);
    }
  };

  if (mut.kind === 'script') {
    const handlerName = typeof mut.handler === 'string' ? mut.handler : '';
    const fn = handlers[handlerName];
    if (!fn) {
      console.warn(`[shim] script: unknown handler "${mut.handler}"`);
      // Missing handler is a kind of authoring error too — surface it the same
      // way as a throw so the LLM learns the rule emitted a handler name that
      // doesn't exist (probably a typo or stale ref).
      if (typeof api.reportEvent === 'function') {
        api.reportEvent('handler-error', {
          specId: spec.id,
          handlerName: mut.handler,
          ruleId: rule.id,
          message: `unknown handler "${mut.handler}" — the rule references a handler name that wasn't compiled with this shim`,
          stack: '',
        });
      }
      return Promise.resolve([]);
    }
    return safe(`script handler "${mut.handler}"`, mut.handler, () =>
      fn({ anchor: el, mutation: mut, rule, spec, api }),
    );
  }

  if (mut.kind === 'hide') {
    const token = `shim-${spec.id}-${rule.id}-hide`;
    injectTier1Rule(token, 'display: none !important;', cssPriorityOf(spec));
    tagElement(el, token);
    return Promise.resolve([]);
  }

  if (mut.kind === 'restyle') {
    const body = cssBodyFromProps(mut.properties);
    if (!body) return Promise.resolve([]);
    const token = `shim-${spec.id}-${rule.id}-restyle`;
    injectTier1Rule(token, body, cssPriorityOf(spec));
    tagElement(el, token);
    return Promise.resolve([]);
  }

  // Tier-1 layout kinds: compile via layout-kinds.ts, ride the same token
  // machinery as hide/restyle. Relative reorder (before/after) compiles to null
  // here — applyRule's restamp path owns it (a whole-sibling ordering can't be
  // expressed as one anchor rule).
  if (mut.kind === 'reorder') {
    const body = compileReorderCss(mut);
    if (body) {
      const token = `shim-${spec.id}-${rule.id}-reorder`;
      injectTier1Rule(token, body, cssPriorityOf(spec));
      tagElement(el, token);
    }
    return Promise.resolve([]);
  }

  if (mut.kind === 'reshape') {
    const body = compileReshapeCss(mut);
    if (body) {
      const token = `shim-${spec.id}-${rule.id}-reshape`;
      injectTier1Rule(token, body, cssPriorityOf(spec));
      tagElement(el, token);
    }
    return Promise.resolve([]);
  }

  // Tier-2 declarative injection: build static DOM from the payload,
  // insert per `placement`, and RETURN the nodes — the script-output path
  // (self-healing, per-anchor dedupe, teardown, emit feedback) does the rest.
  if (mut.kind === 'inject-element') {
    return safe(`inject-element ${rule.id}`, null, () => {
      if (!mut.element) return [];
      const pos = resolvePlacement(el, mut.placement);
      if (!pos) return [];
      const node = buildElement(mut.element, document);
      node.setAttribute('data-shim-injected', `shim-${spec.id}-${rule.id}-inject`);
      pos.parent.insertBefore(node, pos.before);
      return [node];
    });
  }

  if (mut.kind === 'inject-html') {
    return safe(`inject-html ${rule.id}`, null, () => {
      if (typeof mut.html !== 'string') return [];
      const pos = resolvePlacement(el, mut.placement);
      if (!pos) return [];
      const { nodes, stripped } = parseInjectHtml(mut.html, document);
      const noteKey = `${spec.id}/${rule.id}`;
      if (stripped > 0) {
        injectStripNotes.set(noteKey,
          `inject-html stripped ${stripped} active item(s) (scripts / on* handlers / javascript: URLs) — `
          + 'inject kinds are static-only; use a script handler for behavior');
      } else {
        injectStripNotes.delete(noteKey);
      }
      for (const node of nodes) {
        node.setAttribute('data-shim-injected', `shim-${spec.id}-${rule.id}-inject`);
        pos.parent.insertBefore(node, pos.before);
      }
      return nodes;
    });
  }

  // Tier 3 — delete the anchor outright. Hostile to reconcilers by design: the
  // engine's scan loop catches re-rendered nodes and re-removes them.
  // Irreversible by nature — toggle-off can't restore a deleted node; the user
  // reloads, or the framework re-renders, to recover. Prefer `hide` unless the
  // parent's layout actually depends on child count / structural selectors
  // (`:nth-child`, flex/grid count, etc.).
  if (mut.kind === 'remove') {
    el.remove();
    return Promise.resolve([]);
  }

  // Tier 4 `replace-root` — mount handler-returned DOM inside the anchor and
  // hide the anchor's original children via CSS. Reversible: toggle-off strips
  // the token, the CSS rule comes out of the sheet, original children reappear.
  // Handler contract mirrors `script`: it returns the node(s) it mounted; the
  // engine tags each with `data-shim-mounted="<token>"` so the children-hide
  // rule's `:not(...)` clause spares them. Self-healing comes for free from the
  // scan loop — if the framework reconciles our mount away, the next scan
  // re-runs the handler.
  if (mut.kind === 'replace-root') {
    const handlerName = typeof mut.handler === 'string' ? mut.handler : '';
    const fn = handlers[handlerName];
    if (!fn) {
      console.warn(`[shim] replace-root: unknown handler "${mut.handler}"`);
      if (typeof api.reportEvent === 'function') {
        api.reportEvent('handler-error', {
          specId: spec.id,
          handlerName: mut.handler,
          ruleId: rule.id,
          message: `unknown handler "${mut.handler}" — the rule references a handler name that wasn't compiled with this shim`,
          stack: '',
        });
      }
      return Promise.resolve([]);
    }
    const token = `shim-${spec.id}-${rule.id}-replace-root`;
    injectReplaceRootRule(token);
    tagReplaceRootAnchor(el, token);
    return safe(`replace-root handler "${mut.handler}"`, mut.handler, () =>
      fn({ anchor: el, mutation: mut, rule, spec, api }),
    ).then((nodes) => {
      for (const n of nodes) tagMountedNode(n, token);
      return nodes;
    });
  }

  const handler = mutations[mut.kind];
  if (!handler) {
    console.warn(`[shim] unknown mutation kind: ${mut.kind}`);
    return Promise.resolve([]);
  }
  // Custom declarative mutations don't carry a handler-name slot in the event
  // vocabulary; pass null so the throw still hits the console but no event is
  // emitted. (None ship today.)
  return safe(`mount ${rule.id}/${mut.kind}`, null, () =>
    handler.mount(el, mut, rule, spec, api),
  );
}
