// The install page: read a `.shim` file, prepare it (parse, lint, preflight
// against the mode in force), show what it is and which sites it needs,
// then, on the user's click, ask Chrome for exactly those sites and hand
// the prepared install to the worker. The grant prompt is Chrome's own, so
// it needs the click: the request runs in the click handler, nowhere else.
//
// The preparation itself runs in a sandboxed frame (prepare.ts): this
// page's CSP permits no eval, and the handler-module check needs it.

import type { PreparedInstall, InstallRefusal } from './install';
import type { ExtensionMode } from './capabilities';
import { isPrepareAnswer, PREPARE_READY, PREPARE_PING, type PrepareRequest } from './prepare';
import type { ToWorker, WorkerAnswer } from './messages';
import { placedFields } from './credential-grants';
import { accessPatternForOrigin } from './credential-access';
import { describeCredentialUse } from '@shimbrowser/core/credential-placement';
import { accessText, placementText } from './grant-text';

const ask = (msg: ToWorker): Promise<WorkerAnswer> => chrome.runtime.sendMessage(msg);
const PREPARE_TIMEOUT_MS = 15000;
const PING_EVERY_MS = 100;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function must<T extends Element>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`install: no #${id}`);
  return node as unknown as T;
}

const drop = must<HTMLElement>('drop');
const fileInput = must<HTMLInputElement>('file');
const review = must<HTMLElement>('review');
const result = must<HTMLElement>('result');
const sandbox = must<HTMLIFrameElement>('prepare');

// --- the sandboxed check ---------------------------------------------------------

// The frame may have run before this script loaded and its one unsolicited
// readiness message be lost, so readiness is the parent's to ask for: a ping
// every so often until the frame answers, inside the same deadline as the
// check itself.
let sandboxReady = false;
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== sandbox.contentWindow) return;
  const data = event.data as { type?: unknown } | null;
  if (data?.type === PREPARE_READY) sandboxReady = true;
});

function waitForSandbox(deadline: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (sandboxReady) { resolve(); return; }
      if (Date.now() >= deadline) { reject(new Error('the install check did not start')); return; }
      // The sandbox has an opaque origin, so the target origin is the
      // wildcard; the frame is ours and answers only its parent.
      sandbox.contentWindow?.postMessage({ type: PREPARE_PING }, '*');
      setTimeout(tick, PING_EVERY_MS);
    };
    tick();
  });
}

let lastToken = 0;

/** Prepare `text` in the sandbox. Answers are matched by token, so a slower earlier file never answers a later one. */
/** The mode in force, from the worker, which is the one that measures it. */
async function modeInForce(): Promise<{ mode: ExtensionMode; vault: boolean }> {
  const answer = await ask({ type: 'mode' });
  if (!answer.ok || !('mode' in answer)) throw new Error(`could not read the mode: ${answer.ok ? 'no mode in the answer' : answer.error}`);
  return { mode: answer.mode, vault: 'vault' in answer && answer.vault === true };
}

async function prepare(text: string): Promise<PreparedInstall | InstallRefusal> {
  const token = ++lastToken;
  const deadline = Date.now() + PREPARE_TIMEOUT_MS;
  const { mode, vault } = await modeInForce();
  await waitForSandbox(deadline);
  return new Promise((resolve, reject) => {
    const done = (): void => {
      clearTimeout(timer);
      window.removeEventListener('message', onAnswer);
    };
    const onAnswer = (event: MessageEvent<unknown>): void => {
      if (event.source !== sandbox.contentWindow || !isPrepareAnswer(event.data) || event.data.token !== token) return;
      done();
      resolve(event.data.result);
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error('the install check did not answer'));
    }, Math.max(0, deadline - Date.now()));
    window.addEventListener('message', onAnswer);
    const request: PrepareRequest = { type: 'prepare', token, text, mode, vault };
    sandbox.contentWindow?.postMessage(request, '*');
  });
}

// --- the review -------------------------------------------------------------------

function describe(term: string, value: string, mono = false): [HTMLElement, HTMLElement] {
  return [el('dt', undefined, term), el('dd', mono ? 'mono' : undefined, value)];
}

function showRefusal(refusal: InstallRefusal, fileName: string): void {
  review.replaceChildren();
  review.hidden = false;
  result.hidden = true;
  review.append(el('h2', undefined, `cannot install ${fileName}`));
  review.append(el('p', 'error', refusal.error === 'unsupported'
    ? 'this shim needs something this browser cannot run'
    : `the file could not be read (${refusal.error})`));
  const list = el('ul', 'problems');
  for (const problem of refusal.problems) list.append(el('li', undefined, problem));
  review.append(list);
}

function showError(message: string, fileName: string): void {
  review.replaceChildren();
  review.hidden = false;
  result.hidden = true;
  review.append(el('h2', undefined, `cannot install ${fileName}`));
  review.append(el('p', 'error', message));
}

function showReview(prepared: PreparedInstall, fileName: string): void {
  review.replaceChildren();
  review.hidden = false;
  result.hidden = true;
  review.append(el('h2', undefined, `ready to install ${fileName}`));
  const facts = el('dl');
  facts.append(...describe('name', prepared.name));
  facts.append(...describe('sites', prepared.hosts.join(', '), true));
  facts.append(...describe('rules', `${prepared.ruleCount} (${prepared.mutationKinds.join(', ') || 'none'})`));
  if (prepared.userData.length) facts.append(...describe('saved data', `${prepared.userData.length} row${prepared.userData.length === 1 ? '' : 's'} come with it`));
  if (typeof prepared.envelope.intent === 'string') facts.append(...describe('intent', prepared.envelope.intent));
  review.append(facts);

  // Each placed secret, worded by Shim for Chrome itself: where the value
  // goes and how. Approving one here is the same grant the settings page
  // writes, its site access asked for in the install click.
  const secrets = placedFields(prepared.spec).map((f) => ({ ...f, access: accessPatternForOrigin(f.use.origin) }));
  const approvals = new Map<string, HTMLInputElement>();
  if (secrets.length) {
    const box = el('div', 'secrets');
    box.append(el('h3', undefined, 'secrets it sends'));
    box.append(el('p', 'soft', 'The shim never sees these values. After installing, set a passphrase for the vault and enter each value on the shim\'s settings page.'));
    for (const f of secrets) {
      const item = el('div', 'secret');
      const placement = { origin: f.use.origin, placement: f.use.header !== undefined ? { header: f.use.header } : { query: f.use.query }, format: f.use.format };
      item.append(el('div', 'secret-label', `the shim calls it: ${f.label}`));
      item.append(el('div', undefined, `Sent ${describeCredentialUse(f.use)}.`));
      item.append(el('div', 'soft', `Placed in ${placementText(placement)}.`));
      const row = el('label', 'row');
      const check = el('input');
      check.type = 'checkbox';
      check.disabled = f.access === null;
      row.append(check, el('span', undefined, ' approve sending it now'));
      item.append(row, el('div', 'muted', accessText(placement)));
      approvals.set(f.key, check);
      box.append(item);
    }
    review.append(box);
  }
  review.append(el('p', 'soft', secrets.length
    ? 'Installing asks Chrome to let Shim run on these sites, and for access to each secret\'s destination you approve. Nothing else is requested.'
    : 'Installing asks Chrome to let Shim run on these sites. Nothing else is requested.'));

  const actions = el('div', 'actions');
  const install = el('button', 'primary', 'install');
  const status = el('span', 'muted');
  install.addEventListener('click', async () => {
    install.disabled = true;
    status.textContent = '';
    const approved = secrets.filter((f) => approvals.get(f.key)?.checked === true && f.access !== null);
    const origins = [...new Set([...prepared.matchPatterns, ...approved.map((f) => f.access as string)])];
    let granted: boolean;
    try {
      granted = await chrome.permissions.request({ origins });
    } catch (err) {
      status.textContent = `could not ask for site access: ${err instanceof Error ? err.message : String(err)}`;
      install.disabled = false;
      return;
    }
    if (!granted) {
      status.textContent = 'site access was not granted, so the shim was not installed';
      install.disabled = false;
      return;
    }
    const answer = await ask({ type: 'install.commit', prepared, provenance: { source: 'file' }, approveGrants: approved.map((f) => f.key) });
    if (!answer.ok) {
      status.textContent = `the extension refused the install: ${answer.error}`;
      install.disabled = false;
      return;
    }
    review.hidden = true;
    result.replaceChildren();
    result.hidden = false;
    result.append(el('h2', undefined, `${prepared.name} is installed`));
    result.append(el('p', undefined, `It runs on ${prepared.hosts.join(', ')} from the next page load. Turn it off or remove it from the Shim popup.`));
    if (secrets.length) result.append(el('p', 'soft', 'Open its settings from the Shim popup to set up the vault and enter its secrets.'));
    const unapproved = 'unapproved' in answer && Array.isArray(answer.unapproved) ? answer.unapproved : [];
    if (unapproved.length) result.append(el('p', 'error', `Not approved (no site access): ${unapproved.join(', ')}. Approve them on its settings page.`));
    const another = el('button', undefined, 'install another');
    another.addEventListener('click', () => { result.hidden = true; });
    result.append(another);
  });
  actions.append(install, status);
  review.append(actions);
}

async function take(file: File): Promise<void> {
  const text = await file.text();
  let outcome: PreparedInstall | InstallRefusal;
  try {
    outcome = await prepare(text);
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err), file.name);
    return;
  }
  if (outcome.ok) showReview(outcome, file.name);
  else showRefusal(outcome, file.name);
}

drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') fileInput.click();
});
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void take(file);
  fileInput.value = '';
});
drop.addEventListener('dragover', (event) => {
  event.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (event) => {
  event.preventDefault();
  drop.classList.remove('over');
  const file = event.dataTransfer?.files[0];
  if (file) void take(file);
});
