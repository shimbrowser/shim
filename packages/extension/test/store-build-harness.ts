// Pins what ships: dist/, the folder a release zips, holds no test surface.
// The worker's `shimPageHosts` handle answers consent cards and attaches the
// debugger, and the vault's test keys give a shim a world of its own or switch
// the vault, so each name below must be in the test build and in no shipped
// script. The first half is what keeps this list honest: a name that left the
// test build would otherwise pass here for ever.

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const STORE = path.join(ROOT, 'packages', 'extension', 'dist');
const TEST = path.join(ROOT, 'packages', 'extension', 'dist-test');

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passes++; return; }
  failures++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

const TEST_ONLY = [
  'shimPageHosts', 'pageHosts',
  'vault.testWorlds', 'vault.testOn', 'vaultTestWorlds', 'vaultForTests', 'setVaultTestWorlds', 'setVaultForTests',
  'forgetHoldSeq', 'forceHoldSeq', 'dropRuntimePorts', 'watchPopups', 'leaseAllowsTop', 'installEvents',
  'vaultKeeper', 'rotateVault', 'interruptVault', 'recoverVault', 'answerCard', 'pendingCards', 'setBridge',
];

/** The whole name: `rotateVaultKey` and `setBridgeEnabled` are the shipped worker's own. */
function hasName(text: string, name: string): boolean {
  return new RegExp(`(?<![\\w$])${name.replaceAll('.', '\\.')}(?![\\w$])`).test(text);
}

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => fs.statSync(path.join(dir, f)).isFile())
    .sort();
}

console.log('\n=== store build harness ===\n');

if (!fs.existsSync(path.join(STORE, 'sw.js')) || !fs.existsSync(path.join(TEST, 'sw.js'))) {
  throw new Error('no built extension (npm run build)');
}

const testWorker = fs.readFileSync(path.join(TEST, 'sw.js'), 'utf8');
for (const name of TEST_ONLY) check(`the test build's worker has ${name}`, hasName(testWorker, name));

const shipped = filesUnder(STORE);
check('dist/ holds the worker', shipped.includes('sw.js'));
for (const file of shipped.filter((f) => /\.(js|html|json)$/.test(f))) {
  const text = fs.readFileSync(path.join(STORE, file), 'utf8');
  for (const name of TEST_ONLY) check(`dist/${file} has no ${name}`, !hasName(text, name));
}

// Only the worker differs, so the harnesses test the scripts that ship.
check('both builds hold the same files', JSON.stringify(shipped) === JSON.stringify(filesUnder(TEST)));
for (const file of shipped.filter((f) => f !== 'sw.js')) {
  check(`dist/${file} is the test build's, byte for byte`,
    fs.existsSync(path.join(TEST, file)) && fs.readFileSync(path.join(STORE, file)).equals(fs.readFileSync(path.join(TEST, file))));
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages', 'extension', 'package.json'), 'utf8')) as { files: string[] };
check('the package publishes no test build', !pkg.files.some((f) => f.includes('test')), pkg.files.join(','));

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
