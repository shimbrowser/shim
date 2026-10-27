// bridge-install-harness — installing the bridge as a native messaging host
// (packages/mcp/src/bridge-install.ts): the user data directories per
// platform, the wrapper Chrome runs (absolute Node and bundle, `bridge`,
// the origin passed through), the manifest (name, stdio, the one allowed
// origin), the id check, an install that writes only into browsers that are
// there (or one named directory), and the status read back.
//
//   node out/packages/mcp/test/bridge-install-harness.js

import * as path from 'path';
import {
  browserDataDirs, extensionIdProblem, wrapperScript, manifestJson, installHost, hostStatus, HOST_NAME, WRAPPER_NAME, MANIFEST_DIR, type InstallFs,
} from '../src/bridge-install';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passes++; return; }
  failures++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

function memFs(existing: string[] = []): InstallFs & { files: Map<string, { text: string; mode: number }>; dirs: Set<string> } {
  const files = new Map<string, { text: string; mode: number }>();
  const dirs = new Set(existing);
  return {
    files, dirs,
    exists: (p) => dirs.has(p) || files.has(p),
    mkdir: (p) => { dirs.add(p); },
    write: (p, text, mode) => { files.set(p, { text, mode }); },
    read: (p) => files.get(p)?.text ?? null,
  };
}

const ID = 'abcdefghijklmnopabcdefghijklmnop';

{
  const mac = browserDataDirs('darwin', '/Users/u');
  check('macOS: four browsers under Application Support', mac.map((b) => b.browser).join() === 'Chrome,Chromium,Brave,Edge' && mac[0]?.dir === '/Users/u/Library/Application Support/Google/Chrome');
  const linux = browserDataDirs('linux', '/home/u', { XDG_CONFIG_HOME: '/cfg' });
  check('Linux: under XDG_CONFIG_HOME when set', linux[0]?.dir === '/cfg/google-chrome' && linux[2]?.dir === '/cfg/BraveSoftware/Brave-Browser');
  check('Linux: ~/.config otherwise', browserDataDirs('linux', '/home/u')[1]?.dir === '/home/u/.config/chromium');
  check('Windows: none here (a registry key, with packaging)', browserDataDirs('win32', 'C:\\u').length === 0);
}

{
  check('a valid id passes', extensionIdProblem(ID) === null);
  check('a short id, or one with letters past p, is refused', extensionIdProblem('abc') !== null && extensionIdProblem('abcdefghijklmnopabcdefghijklmnoz') !== null);
  const w = wrapperScript('/usr/local/bin/node', "/Users/u/it's/shim.js");
  check('the wrapper execs the absolute Node on the absolute bundle with bridge, passing Chrome\'s arguments on', w.startsWith('#!/bin/sh\n') && w.includes(`exec '/usr/local/bin/node' '/Users/u/it'\\''s/shim.js' bridge "$@"`), w);
  const m = JSON.parse(manifestJson('/ud/bridge/shim-bridge', ID)) as Record<string, unknown>;
  check('the manifest names the host, stdio, the wrapper and the one origin', m.name === HOST_NAME && m.type === 'stdio' && m.path === '/ud/bridge/shim-bridge' && JSON.stringify(m.allowed_origins) === `["chrome-extension://${ID}/"]`);
}

{
  const fs = memFs(['/Users/u/Library/Application Support/Google/Chrome', '/Users/u/Library/Application Support/BraveSoftware/Brave-Browser']);
  const out = installHost({
    extensionId: ID, nodePath: '/n', bundlePath: '/b/shim.js', bridgeDir: '/ud/bridge', browsers: browserDataDirs('darwin', '/Users/u'),
  }, fs);
  check('the wrapper is written executable in the bridge directory', out.wrapper === path.join('/ud/bridge', WRAPPER_NAME) && fs.files.get(out.wrapper)?.mode === 0o755);
  check('a manifest per browser that is there, none for the others', out.manifests.map((x) => x.browser).join() === 'Chrome,Brave' && out.skipped.map((x) => x.browser).join() === 'Chromium,Edge', JSON.stringify(out));
  const file = out.manifests[0]?.file ?? '';
  check('the manifest lives in NativeMessagingHosts under the browser\'s user data dir', file === path.join('/Users/u/Library/Application Support/Google/Chrome', MANIFEST_DIR, `${HOST_NAME}.json`), file);
  const status = hostStatus({ bridgeDir: '/ud/bridge', browsers: browserDataDirs('darwin', '/Users/u') }, fs);
  check('status reads the wrapper and each manifest back, with the id it allows', status.wrapper.present && status.manifests.filter((x) => x.present).map((x) => `${x.browser}:${x.extensionId}:${x.pathMatches}`).join() === `Chrome:${ID}:true,Brave:${ID}:true` && status.manifests.filter((x) => !x.present).length === 2, JSON.stringify(status));
  const named = installHost({ extensionId: ID, nodePath: '/n', bundlePath: '/b/shim.js', bridgeDir: '/ud/bridge', browsers: [], userDataDir: '/custom/profile' }, memFs());
  check('a named user data directory is written to whether or not it exists yet', named.manifests.length === 1 && named.manifests[0]?.file === path.join('/custom/profile', MANIFEST_DIR, `${HOST_NAME}.json`) && named.skipped.length === 0);
  const stale = memFs();
  stale.write(path.join('/Users/u/Library/Application Support/Google/Chrome', MANIFEST_DIR, `${HOST_NAME}.json`), '{"path":"/elsewhere","allowed_origins":["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"]}', 0o644);
  const st = hostStatus({ bridgeDir: '/ud/bridge', browsers: browserDataDirs('darwin', '/Users/u') }, stale);
  check('a manifest pointing elsewhere shows its id and that the path differs', st.manifests[0]?.present === true && st.manifests[0].extensionId === 'a'.repeat(32) && !st.manifests[0].pathMatches && !st.wrapper.present);
}

if (failures) {
  console.error(`\nbridge-install: ${failures} failed, ${passes} passed`);
  process.exit(1);
}
console.log(`bridge-install: all ${passes} checks passed`);
