// Installing the bridge as a native messaging host: the files Chrome needs
// to start `shim bridge` when Shim for Chrome connects. Pure decisions over
// an injected filesystem, so a harness covers every platform.
//
// Chrome starts a native host by running the manifest's `path` with the
// extension's origin as the argument, so the manifest cannot name the
// `shim` command with `bridge` after it: a small wrapper script does that,
// written beside the manifests, naming the absolute Node and the absolute
// `shim` bundle that ran the installer (nothing on PATH is assumed).
// Manifests go under each Chromium's user data directory, in
// `NativeMessagingHosts/` (where Chrome reads user-level manifests), for
// every browser found: Chrome, Chromium, Brave, Edge, or one named
// directory. Windows needs a registry key as well and is not done here.

import * as path from 'path';

export const HOST_NAME = 'com.shimbrowser.bridge';
export const MANIFEST_DIR = 'NativeMessagingHosts';
export const WRAPPER_NAME = 'shim-bridge';

export interface BrowserDir {
  browser: string;
  /** The browser's user data directory. */
  dir: string;
}

/** Each Chromium's user data directory on this platform, whether or not it exists. */
export function browserDataDirs(platform: string, homedir: string, env: Record<string, string | undefined> = {}): BrowserDir[] {
  if (platform === 'darwin') {
    const base = path.join(homedir, 'Library', 'Application Support');
    return [
      { browser: 'Chrome', dir: path.join(base, 'Google', 'Chrome') },
      { browser: 'Chromium', dir: path.join(base, 'Chromium') },
      { browser: 'Brave', dir: path.join(base, 'BraveSoftware', 'Brave-Browser') },
      { browser: 'Edge', dir: path.join(base, 'Microsoft Edge') },
    ];
  }
  if (platform === 'linux') {
    const base = env.XDG_CONFIG_HOME || path.join(homedir, '.config');
    return [
      { browser: 'Chrome', dir: path.join(base, 'google-chrome') },
      { browser: 'Chromium', dir: path.join(base, 'chromium') },
      { browser: 'Brave', dir: path.join(base, 'BraveSoftware', 'Brave-Browser') },
      { browser: 'Edge', dir: path.join(base, 'microsoft-edge') },
    ];
  }
  return [];
}

/** A Chrome extension id: 32 letters a to p. */
export function extensionIdProblem(id: string): string | null {
  return /^[a-p]{32}$/.test(id) ? null : 'an extension id is 32 letters a–p (chrome://extensions shows it under the extension\'s name)';
}

export function wrapperScript(nodePath: string, bundlePath: string): string {
  const q = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
  return `#!/bin/sh\n# Shim for Chrome's bridge: started by Chrome (native messaging), never by hand.\nexec ${q(nodePath)} ${q(bundlePath)} bridge "$@"\n`;
}

export function manifestJson(wrapperPath: string, extensionId: string): string {
  return `${JSON.stringify({
    name: HOST_NAME,
    description: 'Shim for Chrome: the bridge Claude Code authors through',
    path: wrapperPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  }, null, 2)}\n`;
}

export interface InstallFs {
  exists(p: string): boolean;
  mkdir(p: string): void;
  write(p: string, text: string, mode: number): void;
  read(p: string): string | null;
}

export interface InstallHostOptions {
  extensionId: string;
  nodePath: string;
  bundlePath: string;
  /** Where the wrapper goes: `<userData>/bridge/`. */
  bridgeDir: string;
  /** The browsers to install into; one named directory instead with `userDataDir`. */
  browsers: BrowserDir[];
  userDataDir?: string;
}

export interface InstallHostResult {
  wrapper: string;
  manifests: Array<{ browser: string; file: string }>;
  /** Browsers whose user data directory is not there: nothing written for them. */
  skipped: Array<{ browser: string; dir: string }>;
}

export function installHost(opts: InstallHostOptions, fs: InstallFs): InstallHostResult {
  const wrapper = path.join(opts.bridgeDir, WRAPPER_NAME);
  fs.mkdir(opts.bridgeDir);
  fs.write(wrapper, wrapperScript(opts.nodePath, opts.bundlePath), 0o755);
  const targets = opts.userDataDir ? [{ browser: 'the named user data directory', dir: opts.userDataDir }] : opts.browsers;
  const manifests: InstallHostResult['manifests'] = [];
  const skipped: InstallHostResult['skipped'] = [];
  for (const target of targets) {
    if (!opts.userDataDir && !fs.exists(target.dir)) {
      skipped.push(target);
      continue;
    }
    const dir = path.join(target.dir, MANIFEST_DIR);
    fs.mkdir(dir);
    const file = path.join(dir, `${HOST_NAME}.json`);
    fs.write(file, manifestJson(wrapper, opts.extensionId), 0o644);
    manifests.push({ browser: target.browser, file });
  }
  return { wrapper, manifests, skipped };
}

export interface HostStatus {
  wrapper: { file: string; present: boolean };
  manifests: Array<{ browser: string; file: string; present: boolean; extensionId: string | null; pathMatches: boolean }>;
}

/** What is installed: the wrapper, and per browser the manifest with the id it allows. */
export function hostStatus(opts: { bridgeDir: string; browsers: BrowserDir[]; userDataDir?: string }, fs: InstallFs): HostStatus {
  const wrapper = path.join(opts.bridgeDir, WRAPPER_NAME);
  const targets = opts.userDataDir ? [{ browser: 'the named user data directory', dir: opts.userDataDir }] : opts.browsers;
  const manifests = targets.map((t) => {
    const file = path.join(t.dir, MANIFEST_DIR, `${HOST_NAME}.json`);
    const text = fs.read(file);
    let extensionId: string | null = null;
    let pathMatches = false;
    if (text !== null) {
      try {
        const parsed = JSON.parse(text) as { allowed_origins?: unknown; path?: unknown };
        const origin = Array.isArray(parsed.allowed_origins) ? parsed.allowed_origins.find((o): o is string => typeof o === 'string') : undefined;
        const m = origin ? /^chrome-extension:\/\/([a-p]{32})\/$/.exec(origin) : null;
        extensionId = m?.[1] ?? null;
        pathMatches = parsed.path === wrapper;
      } catch { /* not a manifest */ }
    }
    return { browser: t.browser, file, present: text !== null, extensionId, pathMatches };
  });
  return { wrapper: { file: wrapper, present: fs.exists(wrapper) }, manifests };
}
