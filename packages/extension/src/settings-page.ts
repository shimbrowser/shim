// A shim's settings page (settings.html?shim=<id>), opened from the popup:
// one control per declared field, each saved as it changes, with a reset
// that drops the stored value so the field reads its default again. The
// worker checks every value against the declaration before it stores it.
// Everything shown is data from the worker, rendered as text, never markup.
//
// With the vault on, the page also holds the vault (setup, unlock, lock,
// reset, passphrase and key changes: vault-ui.ts) and, for each secret field
// that declares where it goes, the approval to send it there and the value
// to send. What the shim wrote (a field's label and help) is shown apart
// from what Shim for Chrome says about it (where the value goes, whether it
// is approved). settings.html?vault opens the vault alone.

import type { GrantView } from './credential-grants';
import { accessText, placementText } from './grant-text';
import type { SettingsPageField } from './settings';
import { ask, el, vaultView, renderVaultSection } from './vault-ui';
import type { VaultView } from './messages';

function must<T extends Element>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`settings: no #${id}`);
  return node as unknown as T;
}

const params = new URLSearchParams(location.search);
const shimId = params.get('shim') ?? '';
const vaultOnly = params.has('vault');

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

/**
 * A secret field: Shim for Chrome's own box (where the value goes, the
 * approval, the value itself), apart from the shim's label and help above it.
 */
function renderSecret(card: HTMLElement, field: SettingsPageField, grant: GrantView | undefined, vault: VaultView | null, shimName: string, rerender: () => void): void {
  if (!vault?.enabled || !grant) {
    card.append(el('div', 'muted', vault?.enabled
      ? 'this secret declares no destination, so Shim for Chrome cannot send it for the shim'
      : 'secret settings are turned off in this build of Shim for Chrome'));
    return;
  }
  const trusted = el('div', 'trusted');
  trusted.append(el('div', 'trusted-caption', 'Shim for Chrome'));
  trusted.append(el('div', undefined, `${shimName} sends this value ${grant.description}. It never sees the value itself.`));
  trusted.append(el('div', 'soft', `Placed in ${placementText(grant)}.`));
  if (grant.state !== 'granted') trusted.append(el('div', 'soft', accessText(grant)));
  const status = el('div', 'status');
  const say = (answer: { ok: boolean; error?: string }, ok: string): void => {
    status.className = answer.ok ? 'status ok' : 'status error';
    status.textContent = answer.ok ? ok : answer.error ?? '';
  };
  const grantRow = el('div', 'row');
  const state = grant.state === 'granted' ? 'approved' : grant.state === 'suspended' ? 'approval paused: the shim changed since you approved it' : 'not approved';
  grantRow.append(el('span', `grow ${grant.state === 'granted' ? 'ok-text' : 'warn-text'}`, state));
  if (grant.state === 'granted') {
    const revoke = el('button', 'danger', 'revoke');
    revoke.addEventListener('click', async () => {
      revoke.disabled = true;
      const answer = await ask({ type: 'grants.revoke', id: shimId, key: field.key });
      say(answer, 'revoked');
      if (answer.ok) rerender();
    });
    grantRow.append(revoke);
  } else {
    const approve = el('button', 'primary', grant.state === 'suspended' ? 'approve again' : 'approve');
    approve.addEventListener('click', async () => {
      approve.disabled = true;
      // Chrome's prompt needs this click: the request comes first, nothing awaited before it.
      let granted: boolean;
      try {
        granted = grant.access !== '' && await chrome.permissions.request({ origins: [grant.access] });
      } catch (err) {
        say({ ok: false, error: `could not ask for access to ${grant.origin}: ${err instanceof Error ? err.message : String(err)}` }, '');
        approve.disabled = false;
        return;
      }
      if (!granted) {
        say({ ok: false, error: `access to ${grant.origin} was not granted, so this was not approved` }, '');
        approve.disabled = false;
        return;
      }
      const answer = await ask({ type: 'grants.approve', id: shimId, key: field.key, review: grant.review });
      say(answer, 'approved: reload the shim\'s pages to use it');
      if (answer.ok) rerender();
      approve.disabled = false;
    });
    grantRow.append(approve);
  }
  trusted.append(grantRow);

  const valueRow = el('div', 'row');
  if (vault.state !== 'unlocked') {
    valueRow.append(el('span', 'muted grow', grant.isSet ? 'a value is saved. Unlock the vault (above) to replace it.' : 'unlock the vault (above) to enter the value'));
  } else {
    const input = el('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.placeholder = grant.isSet ? 'a value is saved; enter a new one to replace it' : 'the value';
    input.className = 'vault-input grow';
    const save = el('button', undefined, 'save');
    save.addEventListener('click', async () => {
      const value = input.value;
      input.value = '';
      const answer = await ask({ type: 'secrets.set', id: shimId, key: field.key, value });
      say(answer, 'saved, encrypted');
      if (answer.ok) rerender();
    });
    valueRow.append(input, save);
  }
  if (grant.isSet) {
    const clear = el('button', undefined, 'clear');
    clear.addEventListener('click', async () => {
      const answer = await ask({ type: 'secrets.clear', id: shimId, key: field.key });
      say(answer, 'cleared');
      if (answer.ok) rerender();
    });
    valueRow.append(clear);
  }
  trusted.append(valueRow, status);
  card.append(trusted);
}

function renderField(field: SettingsPageField, rerender: () => void, secret?: { grant: GrantView | undefined; vault: VaultView | null; shimName: string }): HTMLElement {
  const card = el('div', 'card field');
  const head = el('div', 'row');
  const label = el('label', 'grow', field.label);
  label.htmlFor = `field-${field.key}`;
  head.append(label);
  if (field.required) head.append(el('span', 'pill', 'required'));
  card.append(head);
  if (field.help) card.append(el('div', 'help', field.help));

  if (field.type === 'secret') {
    renderSecret(card, field, secret?.grant, secret?.vault ?? null, secret?.shimName ?? '', rerender);
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
  const vaultBox = must<HTMLElement>('vault');
  const vault = await vaultView();
  const rerender = (): void => { void render(); };
  if (vaultOnly) {
    must<HTMLElement>('title').textContent = 'secrets vault';
    document.title = 'Shim secrets vault';
    must<HTMLElement>('intro').hidden = true;
    if (vault?.enabled) renderVaultSection(vaultBox, vault, rerender);
    else vaultBox.replaceChildren(el('p', 'muted', 'secret settings are not available in Shim for Chrome yet'));
    return;
  }
  if (!shimId) { showError('no shim named: open settings from the extension\'s popup'); return; }
  const answer = await ask({ type: 'settings.fields', id: shimId });
  list.replaceChildren();
  if (!answer.ok) { showError(`could not load the settings: ${answer.error}`); return; }
  if (!('fields' in answer)) return;
  must<HTMLElement>('title').textContent = `${answer.name}: settings`;
  document.title = `${answer.name}: settings`;
  if (!answer.fields.length) list.append(el('p', 'muted', 'this shim declares no settings'));
  const hasSecret = answer.fields.some((f) => f.type === 'secret');
  let grants: GrantView[] = [];
  if (hasSecret && vault?.enabled) {
    const g = await ask({ type: 'grants.list', id: shimId });
    if (g.ok && 'grants' in g) grants = g.grants;
    renderVaultSection(vaultBox, vault, rerender);
  } else {
    vaultBox.replaceChildren();
  }
  for (const field of answer.fields) {
    list.append(renderField(field, rerender, { grant: grants.find((x) => x.key === field.key), vault, shimName: answer.name }));
  }
}

void render();
