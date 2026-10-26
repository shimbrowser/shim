// The popup: the installed shims, each with enable / disable and remove, and
// the way to the install page. Everything it shows is data from the worker,
// rendered as text, never as markup.

import type { ToWorker, WorkerAnswer, ShimSummary } from './messages';

const ask = (msg: ToWorker): Promise<WorkerAnswer> => chrome.runtime.sendMessage(msg);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function must<T extends Element>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`popup: no #${id}`);
  return node as unknown as T;
}

function renderShim(shim: ShimSummary, refresh: () => void): HTMLElement {
  const card = el('div', 'card');
  const top = el('div', 'row');
  const text = el('div', 'grow');
  text.append(el('div', 'name', shim.name));
  text.append(el('div', 'hosts', shim.hosts.join(', ')));
  top.append(text);

  if (shim.needsFullMode) {
    top.append(el('span', 'pill off', 'needs user scripts'));
  } else {
    const toggle = el('input');
    toggle.type = 'checkbox';
    toggle.checked = shim.enabled;
    toggle.title = shim.enabled ? 'on: disable' : 'off: enable';
    toggle.addEventListener('change', async () => {
      toggle.disabled = true;
      await ask({ type: 'shims.setEnabled', id: shim.id, enabled: toggle.checked });
      refresh();
    });
    top.append(toggle);
  }
  card.append(top);

  const bottom = el('div', 'row');
  const rules = el('span', 'muted', `${shim.ruleCount} rule${shim.ruleCount === 1 ? '' : 's'}`);
  bottom.append(rules);
  const spacer = el('span', 'grow');
  bottom.append(spacer);
  const remove = el('button', 'danger', 'remove');
  let armed = false;
  remove.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      remove.textContent = 'really remove?';
      return;
    }
    remove.disabled = true;
    await ask({ type: 'shims.uninstall', id: shim.id });
    refresh();
  });
  bottom.append(remove);
  card.append(bottom);
  return card;
}

async function render(): Promise<void> {
  const list = must<HTMLElement>('list');
  const empty = must<HTMLElement>('empty');
  const mode = must<HTMLElement>('mode');
  const answer = await ask({ type: 'shims.list' });
  list.replaceChildren();
  if (!answer.ok) {
    list.append(el('p', 'error', `could not reach the extension: ${answer.error}`));
    return;
  }
  if (!('shims' in answer) || !Array.isArray(answer.shims)) return;
  const shims = answer.shims as ShimSummary[];
  empty.hidden = shims.length > 0;
  for (const shim of shims) list.append(renderShim(shim, () => { void render(); }));
  mode.replaceChildren();
  if (answer.mode === 'full') {
    mode.textContent = 'user scripts on: shims with handlers run too';
    return;
  }
  // The way to full mode is a toggle on the extension's own page; the popup
  // can open that page but not flip it.
  mode.append(el('span', undefined, 'declarative mode: shims with script rules need user scripts. '));
  const turnOn = el('button', 'link', 'turn them on');
  turnOn.title = 'opens this extension\'s page on chrome://extensions, where "Allow user scripts" lives (developer mode before Chrome 138)';
  turnOn.addEventListener('click', () => {
    void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  });
  mode.append(turnOn);
}

must<HTMLButtonElement>('install').addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('install.html') });
});

void render();
