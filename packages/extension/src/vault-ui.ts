// The vault's controls, shared by the settings page and the popup (the only
// pages the worker answers vault messages to). Unlock, lock and setup live
// here; the settings page adds reset, change of passphrase, rotation of the
// data key and the lock-after choice. Everything shown is data from the
// worker, rendered as text, never markup. A passphrase is read from its
// input when the user acts, sent once, and the input is cleared.

import type { ToWorker, WorkerAnswer, VaultView } from './messages';
import { suggestPassphrase, passphraseProblem } from './vault-crypto';
import { LOCK_AFTER_CHOICES } from './vault-keeper';

export const ask = (msg: ToWorker): Promise<WorkerAnswer> => chrome.runtime.sendMessage(msg);

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export async function vaultView(): Promise<VaultView | null> {
  const answer = await ask({ type: 'vault.status' });
  const view = answer.ok ? (answer as { vault?: unknown }).vault : undefined;
  return typeof view === 'object' && view !== null && 'state' in view ? view as VaultView : null;
}

function passwordInput(placeholder: string, autocomplete: AutoFill): HTMLInputElement {
  const input = el('input');
  input.type = 'password';
  input.placeholder = placeholder;
  input.autocomplete = autocomplete;
  input.spellcheck = false;
  input.className = 'vault-input';
  return input;
}

function untilText(ms: number | null): string {
  return ms === null ? '' : new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function lockAfterLabel(ms: number): string {
  return ms >= 60 * 60 * 1000 ? `${ms / (60 * 60 * 1000)} hour${ms === 60 * 60 * 1000 ? '' : 's'}` : `${ms / 60000} minutes`;
}

/** A button that runs `act`, shows its answer in `status`, and re-renders on success. */
function action(label: string, status: HTMLElement, act: () => Promise<WorkerAnswer>, done: () => void, className?: string): HTMLButtonElement {
  const button = el('button', className, label);
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.className = 'status muted';
    status.textContent = 'working…';
    const answer = await act().catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
    button.disabled = false;
    if (!answer.ok) {
      status.className = 'status error';
      status.textContent = answer.error;
      return;
    }
    status.textContent = '';
    done();
  });
  return button;
}

/** What unlocking enables, said before the user unlocks. */
function grantsList(view: VaultView): HTMLElement {
  const box = el('div', 'vault-grants');
  if (!view.grants.length) {
    box.append(el('div', 'muted', 'No shim is approved to send a secret yet.'));
    return box;
  }
  box.append(el('div', 'soft', 'Unlocking lets these shims send what you approved:'));
  const list = el('ul', 'problems');
  for (const g of view.grants) list.append(el('li', undefined, `${g.shimName}: ${g.label}, ${g.description}`));
  box.append(list);
  return box;
}

/** The setup form: a passphrase (with a generated suggestion) typed twice. */
function setupForm(rerender: () => void): HTMLElement {
  const box = el('div', 'vault-form');
  box.append(el('div', 'soft', 'Secrets are encrypted with a passphrase only you know. Shim for Chrome never asks for it on a website, only here and in its toolbar popup. If you forget it, the vault can be reset, and every secret entered again.'));
  const first = passwordInput('passphrase', 'new-password');
  const second = passwordInput('the same passphrase again', 'new-password');
  const shown = el('div', 'mono');
  const status = el('div', 'status');
  const suggest = el('button', undefined, 'suggest one');
  suggest.addEventListener('click', () => {
    const p = suggestPassphrase();
    first.value = p;
    second.value = p;
    shown.textContent = `${p}  (write it down somewhere safe)`;
  });
  const create = action('create the vault', status, async () => {
    if (first.value !== second.value) return { ok: false, error: 'the two passphrases differ' };
    const problem = passphraseProblem(first.value);
    if (problem) return { ok: false, error: problem };
    const passphrase = first.value;
    first.value = '';
    second.value = '';
    shown.textContent = '';
    return ask({ type: 'vault.setup', passphrase });
  }, rerender, 'primary');
  const row = el('div', 'row');
  row.append(create, suggest);
  box.append(first, second, shown, row, status);
  return box;
}

function unlockForm(view: VaultView, rerender: () => void): HTMLElement {
  const box = el('div', 'vault-form');
  const input = passwordInput('passphrase', 'current-password');
  const status = el('div', 'status');
  const unlock = action('unlock', status, async () => {
    const passphrase = input.value;
    input.value = '';
    return ask({ type: 'vault.unlock', passphrase });
  }, rerender, 'primary');
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock.click(); });
  const row = el('div', 'row');
  row.append(input, unlock);
  box.append(grantsList(view), row, status);
  return box;
}

/** The popup's compact vault row; the settings page uses renderVaultSection. */
export function renderVaultCompact(box: HTMLElement, view: VaultView, rerender: () => void): void {
  box.replaceChildren();
  const head = el('div', 'row');
  head.append(el('span', 'grow name', 'secrets vault'));
  const manage = el('button', 'link', 'manage');
  manage.addEventListener('click', () => { void chrome.tabs.create({ url: chrome.runtime.getURL('settings.html?vault') }); });
  head.append(manage);
  box.append(head);
  if (view.state === 'none') {
    box.append(el('div', 'muted', 'not set up'));
  } else if (view.state === 'corrupt') {
    box.append(el('div', 'error', 'the vault cannot be read; reset it under manage'));
  } else if (view.state === 'locked') {
    box.append(unlockForm(view, rerender));
  } else {
    const row = el('div', 'row');
    row.append(el('span', 'grow muted', `unlocked until ${untilText(view.expiresAt)}`));
    const status = el('div', 'status');
    row.append(action('lock', status, () => ask({ type: 'vault.lock' }), rerender));
    box.append(row, status);
  }
}

/** The settings page's vault section: every operation. */
export function renderVaultSection(box: HTMLElement, view: VaultView, rerender: () => void): void {
  box.replaceChildren();
  box.append(el('h2', undefined, 'secrets vault'));
  if (view.state === 'none') {
    box.append(setupForm(rerender));
    return;
  }
  if (view.state === 'corrupt') {
    box.append(el('div', 'error', 'The vault\'s record cannot be read (it may have been damaged). Reset it to start again; every secret will need entering again, and every approval giving again.'));
    box.append(resetForm(rerender, true));
    return;
  }
  if (view.state === 'locked') {
    box.append(unlockForm(view, rerender));
    const forgot = el('details');
    forgot.append(el('summary', 'muted', 'forgot the passphrase?'));
    forgot.append(resetForm(rerender, false));
    box.append(forgot);
    return;
  }
  const status = el('div', 'status');
  const row = el('div', 'row');
  row.append(el('span', 'grow', `Unlocked until ${untilText(view.expiresAt)}.`));
  row.append(action('lock now', status, () => ask({ type: 'vault.lock' }), rerender));
  box.append(row, status);
  box.append(grantsList(view));

  const lockRow = el('div', 'row');
  lockRow.append(el('label', 'grow', 'lock after (unused)'));
  const select = el('select');
  for (const ms of LOCK_AFTER_CHOICES) {
    const o = el('option', undefined, lockAfterLabel(ms));
    o.value = String(ms);
    o.selected = ms === view.lockAfterMs;
    select.append(o);
  }
  const lockStatus = el('div', 'status');
  select.addEventListener('change', async () => {
    const answer = await ask({ type: 'vault.setLockAfter', ms: Number(select.value) });
    lockStatus.className = answer.ok ? 'status ok' : 'status error';
    lockStatus.textContent = answer.ok ? 'saved' : answer.error;
    if (answer.ok) rerender();
  });
  lockRow.append(select);
  box.append(lockRow, el('div', 'muted', 'It always locks 12 hours after you unlock it, when the browser restarts, and when the extension updates.'), lockStatus);

  const change = el('details');
  change.append(el('summary', undefined, 'change the passphrase'));
  {
    const current = passwordInput('current passphrase', 'current-password');
    const next = passwordInput('new passphrase', 'new-password');
    const again = passwordInput('new passphrase again', 'new-password');
    const st = el('div', 'status');
    change.append(current, next, again, action('change it', st, async () => {
      if (next.value !== again.value) return { ok: false, error: 'the two new passphrases differ' };
      const msg: ToWorker = { type: 'vault.changePassphrase', current: current.value, next: next.value };
      current.value = ''; next.value = ''; again.value = '';
      return ask(msg);
    }, rerender), st);
  }
  box.append(change);

  const rotate = el('details');
  rotate.append(el('summary', undefined, 'rotate the encryption key'));
  {
    rotate.append(el('div', 'muted', 'After a suspected exposure: every secret is encrypted again under a new key. Rotate the secrets themselves with their services too.'));
    const pass = passwordInput('passphrase', 'current-password');
    const st = el('div', 'status');
    rotate.append(pass, action('rotate', st, async () => {
      const msg: ToWorker = { type: 'vault.rotateKey', passphrase: pass.value };
      pass.value = '';
      return ask(msg);
    }, rerender), st);
  }
  box.append(rotate);

  const reset = el('details');
  reset.append(el('summary', 'muted', 'reset the vault'));
  reset.append(resetForm(rerender, false));
  box.append(reset);
}

function resetForm(rerender: () => void, open: boolean): HTMLElement {
  const box = el('div', 'vault-form');
  box.append(el('div', 'soft', 'Reset deletes every secret and every approval and creates a new vault under a new passphrase. Shims that send secrets will need their values entered and their approvals given again.'));
  const next = passwordInput('new passphrase', 'new-password');
  const again = passwordInput('new passphrase again', 'new-password');
  const confirm = el('input');
  confirm.type = 'text';
  confirm.placeholder = 'type reset to confirm';
  confirm.className = 'vault-input';
  const st = el('div', 'status');
  box.append(next, again, confirm, action('reset the vault', st, async () => {
    if (confirm.value.trim() !== 'reset') return { ok: false, error: 'type reset to confirm' };
    if (next.value !== again.value) return { ok: false, error: 'the two passphrases differ' };
    const msg: ToWorker = { type: 'vault.reset', passphrase: next.value, confirm: 'reset' };
    next.value = ''; again.value = ''; confirm.value = '';
    return ask(msg);
  }, rerender, open ? 'primary danger' : 'danger'), st);
  return box;
}
