// The attach card: what a session asks before it opens, answered here and
// nowhere else. The worker lists the requests waiting (attach.pending) and
// takes each answer (attach.answer); this page shows them and, on allow,
// first asks Chrome for the site permission the session still needs (the
// click is the user gesture Chrome requires), then sends the answer. The
// window closes once nothing waits.

import type { ToWorker, WorkerAnswer } from './messages';
import type { PendingConsent } from './attach-consent';

const ask = (msg: ToWorker): Promise<WorkerAnswer> => chrome.runtime.sendMessage(msg);
const POLL_MS = 500;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function must<T extends Element>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`attach: no #${id}`);
  return node as unknown as T;
}

const cards = must<HTMLElement>('cards');
const none = must<HTMLElement>('none');
const shown = new Map<string, HTMLElement>();

function render(pending: PendingConsent[]): void {
  // The worker owns this window: it closes it when nothing waits, and opens
  // a fresh one for the next request. The page only shows what is pending.
  const ids = new Set(pending.map((p) => p.id));
  for (const [id, node] of [...shown]) {
    if (!ids.has(id)) { node.remove(); shown.delete(id); }
  }
  for (const p of pending) {
    if (shown.has(p.id)) continue;
    const card = renderCard(p);
    shown.set(p.id, card);
    cards.append(card);
  }
  none.hidden = pending.length > 0;
}

function renderCard(p: PendingConsent): HTMLElement {
  const card = el('div', 'card');
  const where = p.openUrl ? `open a new tab at ${p.openUrl}` : (p.url ?? 'this tab');
  card.append(el('p', 'name', `${p.agent} wants to work on ${p.shimId ? `"${p.shimName}"` : `a new shim, "${p.shimName}",`} on ${p.scope}`));
  card.append(el('p', 'soft', p.openUrl ? `It asks Shim for Chrome to ${where}.` : `The tab: ${p.title ? `${p.title} (${where})` : where}`));
  if (p.intent.trim()) {
    card.append(el('p', 'soft', 'What it set out to do:'));
    card.append(el('div', 'intent', p.intent));
  }
  if (p.missingOrigins.length) card.append(el('p', 'soft', `Allowing also lets Shim for Chrome run on: ${p.missingOrigins.join(', ')}`));
  card.append(el('p', 'warn', 'While the session is open the agent can run code in this page as you, signed in as you are, and take real actions before anything is committed. Discarding its work does not undo those.'));
  const actions = el('div', 'actions');
  const status = el('span', 'muted');
  const answer = async (choice: 'allow-once' | 'allow-host' | 'deny'): Promise<void> => {
    for (const b of actions.querySelectorAll('button')) b.disabled = true;
    if (choice !== 'deny' && p.missingOrigins.length) {
      let granted = false;
      try {
        granted = await chrome.permissions.request({ origins: p.missingOrigins });
      } catch (err) {
        status.textContent = `could not ask for the site: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (!granted) {
        status.textContent = 'the site was not allowed, so the session was denied';
        await ask({ type: 'attach.answer', id: p.id, answer: 'deny' });
        return;
      }
    }
    const out = await ask({ type: 'attach.answer', id: p.id, answer: choice });
    status.textContent = out.ok ? (choice === 'deny' ? 'denied' : 'allowed') : `too late: ${out.error}`;
  };
  const once = el('button', 'primary', 'allow once');
  once.addEventListener('click', () => { void answer('allow-once'); });
  actions.append(once);
  if (!p.openUrl) {
    const host = el('button', undefined, `allow on ${p.scope} until Chrome restarts`);
    host.addEventListener('click', () => { void answer('allow-host'); });
    actions.append(host);
  }
  const deny = el('button', 'danger', 'deny');
  deny.addEventListener('click', () => { void answer('deny'); });
  actions.append(deny);
  actions.append(status);
  card.append(actions);
  return card;
}

async function poll(): Promise<void> {
  const out = await ask({ type: 'attach.pending' }).catch(() => null);
  if (out && out.ok && 'pending' in out) render(out.pending);
  setTimeout(() => { void poll(); }, POLL_MS);
}

void poll();
