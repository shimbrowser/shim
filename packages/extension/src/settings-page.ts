// A shim's settings page (settings.html?shim=<id>), opened from the popup:
// one control per declared field, each saved as it changes, with a reset
// that drops the stored value so the field reads its default again. The
// worker checks every value against the declaration before it stores it.
// Everything shown is data from the worker, rendered as text, never markup.

import type { ToWorker, WorkerAnswer } from './messages';
import type { SettingsPageField } from './settings';

const ask = (msg: ToWorker): Promise<WorkerAnswer> => chrome.runtime.sendMessage(msg);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function must<T extends Element>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`settings: no #${id}`);
  return node as unknown as T;
}

const shimId = new URLSearchParams(location.search).get('shim') ?? '';

function showError(text: string): void {
  const error = must<HTMLElement>('error');
  error.textContent = text;
  error.hidden = false;
}

/** The control for one field, and how to read the value the user entered (undefined: nothing to store). */
function controlFor(field: SettingsPageField): { node: HTMLElement; read(): unknown } {
  const id = `field-${field.key}`;
  switch (field.type) {
    case 'boolean': {
      const box = el('input');
      box.type = 'checkbox';
      box.id = id;
      box.checked = field.value === true;
      return { node: box, read: () => box.checked };
    }
    case 'select': {
      const select = el('select');
      select.id = id;
      if (!field.isSet && field.default === undefined) select.append(el('option', undefined, 'choose…'));
      for (const option of field.options ?? []) {
        const o = el('option', undefined, option);
        o.value = option;
        o.selected = String(field.value) === option;
        select.append(o);
      }
      return { node: select, read: () => ((field.options ?? []).includes(select.value) ? select.value : undefined) };
    }
    case 'number': {
      const input = el('input');
      input.type = 'number';
      input.id = id;
      input.value = typeof field.value === 'number' ? String(field.value) : '';
      return { node: input, read: () => (input.value.trim() === '' ? undefined : Number(input.value)) };
    }
    default: {
      const input = el('input');
      input.type = 'text';
      input.id = id;
      input.value = typeof field.value === 'string' ? field.value : '';
      return { node: input, read: () => input.value };
    }
  }
}

function renderField(field: SettingsPageField, rerender: () => void): HTMLElement {
  const card = el('div', 'card field');
  const head = el('div', 'row');
  const label = el('label', 'grow', field.label);
  label.htmlFor = `field-${field.key}`;
  head.append(label);
  if (field.required) head.append(el('span', 'pill', 'required'));
  card.append(head);
  if (field.help) card.append(el('div', 'help', field.help));

  // A secret field never installs here (no encrypted store), but a shim
  // stored before that rule would still list one: say so, offer no input.
  if (field.type === 'secret') {
    card.append(el('div', 'muted', 'secret settings are not available in Shim for Chrome; use this shim in the Shim browser to set one'));
    return card;
  }

  const control = controlFor(field);
  const status = el('div', 'status');
  const describe = (): void => {
    status.className = 'status muted';
    status.textContent = field.isSet ? '' : field.default !== undefined ? 'using the default' : field.required ? 'needs a value' : 'not set';
  };
  describe();
  const row = el('div', 'row');
  row.append(control.node);
  const reset = el('button', undefined, field.default !== undefined ? 'reset to default' : 'clear');
  reset.hidden = !field.isSet;
  reset.addEventListener('click', async () => {
    reset.disabled = true;
    const answer = await ask({ type: 'settings.clear', id: shimId, key: field.key });
    reset.disabled = false;
    if (!answer.ok) {
      status.className = 'status error';
      status.textContent = answer.error;
      return;
    }
    rerender();
  });
  control.node.addEventListener('change', async () => {
    const value = control.read();
    if (value === undefined) return;
    const answer = await ask({ type: 'settings.set', id: shimId, key: field.key, value });
    if (!answer.ok) {
      status.className = 'status error';
      status.textContent = answer.error;
      return;
    }
    field.isSet = true;
    field.value = value;
    status.className = 'status ok';
    status.textContent = 'saved';
    reset.hidden = false;
  });

  row.append(reset);
  card.append(row, status);
  return card;
}

async function render(): Promise<void> {
  const list = must<HTMLElement>('fields');
  if (!shimId) { showError('no shim named: open settings from the extension\'s popup'); return; }
  const answer = await ask({ type: 'settings.fields', id: shimId });
  list.replaceChildren();
  if (!answer.ok) { showError(`could not load the settings: ${answer.error}`); return; }
  if (!('fields' in answer)) return;
  must<HTMLElement>('title').textContent = `${answer.name}: settings`;
  document.title = `${answer.name}: settings`;
  if (!answer.fields.length) list.append(el('p', 'muted', 'this shim declares no settings'));
  for (const field of answer.fields) list.append(renderField(field, () => { void render(); }));
}

void render();
