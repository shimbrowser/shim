// The popup: the installed shims, each with enable / disable, its settings
// page when it declares settings, and remove, and the way to the install page. Everything it shows is data from the worker,
// rendered as text, never as markup.

import type { ToWorker, WorkerAnswer, ShimSummary, VersionSummary } from './messages';

const ask = (msg: ToWorker): Promise<WorkerAnswer> => chrome.runtime.sendMessage(msg);

/** Hands the user a file from this page: a Blob link, clicked. */
function download(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function when(ms: number): string {
  return new Date(ms).toLocaleString();
}

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
  // A required setting with no value and no default: the shim can't do what
  // it says until one is set on its settings page.
  if (shim.needsSetup) top.append(el('span', 'pill warn', 'needs setup'));

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

  // Rules the ladder could not re-find after a site change: held for review,
  // never silently mis-attached. The way to repair here is to export the
  // file and repair it in Shim or with Claude Code.
  if (shim.review.length) {
    const review = el('div', 'review');
    review.append(el('span', 'pill warn', 'needs review'));
    const list = el('ul', 'problems');
    for (const item of shim.review) list.append(el('li', undefined, `${item.ruleId}: ${item.reason}`));
    review.append(list);
    card.append(review);
  }

  const bottom = el('div', 'row');
  const rules = el('span', 'muted', `${shim.ruleCount} rule${shim.ruleCount === 1 ? '' : 's'} · v${shim.version}`);
  bottom.append(rules);
  const spacer = el('span', 'grow');
  bottom.append(spacer);
  if (shim.settingsCount > 0) {
    const settings = el('button', undefined, 'settings');
    settings.title = 'the values this shim asks for, kept in this browser';
    settings.addEventListener('click', () => {
      void chrome.tabs.create({ url: chrome.runtime.getURL(`settings.html?shim=${encodeURIComponent(shim.id)}`) });
    });
    bottom.append(settings);
  }
  const exportButton = el('button', undefined, 'export');
  exportButton.title = 'save this shim as a .shim file, as it is now, with its saved data';
  exportButton.addEventListener('click', async () => {
    exportButton.disabled = true;
    const answer = await ask({ type: 'shims.export', id: shim.id });
    if (answer.ok && 'file' in answer) download(answer.fileName, answer.file);
    exportButton.disabled = false;
  });
  bottom.append(exportButton);
  const history = el('button', undefined, 'history');
  history.title = 'earlier versions of this shim, each one restorable';
  bottom.append(history);
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

  const versions = el('div', 'versions');
  versions.hidden = true;
  history.addEventListener('click', async () => {
    if (!versions.hidden) { versions.hidden = true; return; }
    versions.replaceChildren();
    const answer = await ask({ type: 'shims.versions', id: shim.id });
    if (!answer.ok || !('versions' in answer)) return;
    const list = answer.versions as VersionSummary[];
    if (!list.length) versions.append(el('div', 'muted', 'no earlier versions'));
    for (const v of [...list].reverse()) {
      const row = el('div', 'row');
      const current = v.version === shim.version;
      row.append(el('span', 'muted', `v${v.version} · ${v.reason} · ${when(v.at)}${current ? ' · current' : ''}`));
      row.append(el('span', 'grow'));
      // The current version is what runs; there is nothing to restore it to.
      if (!current) {
        const restore = el('button', undefined, 'restore');
        restore.addEventListener('click', async () => {
          restore.disabled = true;
          await ask({ type: 'shims.restore', id: shim.id, version: v.version });
          refresh();
        });
        row.append(restore);
      }
      versions.append(row);
    }
    versions.hidden = false;
  });
  card.append(versions);
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

// The bridge to Claude Code: off by default. On, the worker holds a port to
// the native host `shim extension install-host` set up, and an agent can
// open sessions here (each one asks on the attach card first).
async function renderBridge(): Promise<void> {
  const box = must<HTMLElement>('bridge');
  const answer = await ask({ type: 'bridge.status' });
  box.replaceChildren();
  if (!answer.ok || !('bridge' in answer)) return;
  const b = answer.bridge;
  const row = el('label', 'row');
  const toggle = el('input');
  toggle.type = 'checkbox';
  toggle.checked = b.enabled;
  toggle.addEventListener('change', async () => {
    toggle.disabled = true;
    await ask({ type: 'bridge.setEnabled', enabled: toggle.checked });
    await renderBridge();
  });
  row.append(toggle, el('span', 'grow', 'let Claude Code author here'));
  box.append(row);
  const state = !b.enabled ? 'off'
    : b.connected ? `connected${b.sessions ? ` · ${b.sessions} session${b.sessions === 1 ? '' : 's'} open` : ''}`
      : b.error ? `not connected: ${b.error}. Run \`shim extension install-host --extension-id ${chrome.runtime.id}\` once, then try again.`
        : 'connecting…';
  box.append(el('div', b.enabled && !b.connected ? 'error' : 'muted', state));
}

void render();
void renderBridge();
