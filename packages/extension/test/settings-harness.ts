// Pins a shim's settings on this host (src/settings.ts): what a handler
// reads, what the settings page shows and stores, when a shim needs setup,
// and the digest that reboots a shim when a value changes.
//
//   - a handler reads declared keys only, each its stored value, else its
//     default, else undefined; a dropped field's row and an undeclared key
//     read nothing;
//   - a value is stored only for a declared key and only when it fits the
//     field's type; a secret field is never stored;
//   - a malformed declaration offers no fields (and so stores nothing);
//   - needsSetup: a required field with no default and no value;
//   - settingsKey: stable for the same values, different when one changes,
//     absent for a shim without settings, and carrying no value.

import {
  valuesForHandler, valueForHandler, settingsPageFields, needsSetup, checkSettingValue, settingsKey, settingsFields, settingsTransport, fromSettingsTransport,
} from '../src/settings';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passes++; return; }
  failures++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

const SPEC = {
  settings: [
    { key: 'units', type: 'select', options: ['metric', 'imperial'], default: 'metric' },
    { key: 'limit', type: 'number', required: true },
    { key: 'compact', type: 'boolean', default: false },
    { key: 'note', label: 'A note' },
  ],
};

console.log('\n=== settings harness ===\n');

console.log('what a handler reads:');
{
  const all = valuesForHandler(SPEC, {});
  check('unset fields read their default, or undefined', all.units === 'metric' && all.compact === false && all.limit === undefined && all.note === undefined
    && JSON.stringify(Object.keys(all)) === '["units","limit","compact","note"]', JSON.stringify(all));
  const stored = { units: 'imperial', limit: 10, dropped: 'old', note: '' };
  const set = valuesForHandler(SPEC, stored);
  check('a stored value wins over the default (an empty string is a value)', set.units === 'imperial' && set.limit === 10 && set.note === '');
  check('a row a since-removed field left is ignored', !('dropped' in set));
  check('get reads one declared key', valueForHandler(SPEC, stored, 'limit') === 10 && valueForHandler(SPEC, stored, 'compact') === false);
  check('get of an undeclared key, or a non-string key, is undefined', valueForHandler(SPEC, stored, 'dropped') === undefined && valueForHandler(SPEC, stored, 3) === undefined);
  check('a "__proto__" key is data in what a handler reads', (() => {
    const out = valuesForHandler({ settings: [{ key: '__proto__' }] }, JSON.parse('{"__proto__":"x"}') as Record<string, unknown>);
    return Object.hasOwn(out, '__proto__') && out.__proto__ === 'x' && Object.getPrototypeOf(out) === Object.prototype;
  })());
  check('no declaration: a handler reads an empty record', Object.keys(valuesForHandler({}, { units: 'x' })).length === 0);
}

console.log('getAll across a JSON message:');
{
  // chrome.runtime and the session binding are JSON: an undefined value
  // drops out of a record, so the keys travel beside it.
  const wire = JSON.parse(JSON.stringify(settingsTransport(SPEC, { limit: 3 }))) as unknown;
  const back = fromSettingsTransport(wire);
  check('every declared key survives, an unset one as undefined (as the Shim browser\'s IPC delivers it)',
    JSON.stringify(Object.keys(back)) === '["units","limit","compact","note"]' && Object.hasOwn(back, 'note') && back.note === undefined && back.limit === 3 && back.units === 'metric', JSON.stringify(Object.keys(back)));
  check('a plain JSON record loses that key, which is the bug this guards', !('note' in (JSON.parse(JSON.stringify(valuesForHandler(SPEC, {}))) as Record<string, unknown>)));
  check('a malformed transport reads as an empty record', Object.keys(fromSettingsTransport(null)).length === 0 && Object.keys(fromSettingsTransport({ keys: 'x' })).length === 0);
  check('a "__proto__" key is rebuilt as data', (() => {
    const out = fromSettingsTransport(JSON.parse('{"keys":["__proto__"],"values":{"__proto__":"x"}}'));
    return Object.hasOwn(out, '__proto__') && Object.getPrototypeOf(out) === Object.prototype;
  })());
}

console.log('what the page shows:');
{
  const fields = settingsPageFields(SPEC, { limit: 5 });
  const by = new Map(fields.map((f) => [f.key, f]));
  check('fields in declaration order, normalized', fields.map((f) => f.key).join(',') === 'units,limit,compact,note' && by.get('note')?.label === 'A note' && by.get('note')?.type === 'text');
  check('a set field carries its value and isSet', by.get('limit')?.isSet === true && by.get('limit')?.value === 5);
  check('an unset field shows its default, else null, and is not set', by.get('units')?.isSet === false && by.get('units')?.value === 'metric' && by.get('note')?.value === null);
}

console.log('what may be stored:');
{
  const ok = (key: unknown, value: unknown): boolean => checkSettingValue(SPEC, key, value).ok;
  check('each type takes its own kind of value', ok('units', 'imperial') && ok('limit', 3.5) && ok('compact', true) && ok('note', 'hi') && ok('note', ''));
  check('a select takes only one of its options', !ok('units', 'kelvin'));
  check('a number takes a finite number only', !ok('limit', '3') && !ok('limit', Number.NaN) && !ok('limit', Infinity));
  check('a boolean takes a boolean only', !ok('compact', 'true') && !ok('compact', 1));
  check('text takes a string only', !ok('note', 3) && !ok('note', null));
  const undeclared = checkSettingValue(SPEC, 'nope', 'x');
  check('an undeclared key is refused, named', !undeclared.ok && undeclared.error.includes('"nope" is not a declared setting'));
  const secret = checkSettingValue({ settings: [{ key: 'token', type: 'secret' }] }, 'token', 'abc');
  check('a secret field is never stored here', !secret.ok && secret.error.includes('cannot store encrypted'));
  check('a non-string key is refused', !ok(5, 'x'));
}

console.log('a malformed declaration:');
{
  const bad = { settings: [{ key: 'a' }, { key: 'a' }] };
  check('offers no fields', settingsFields(bad).length === 0 && settingsPageFields(bad, {}).length === 0);
  check('so nothing is stored for it and a handler reads nothing', !checkSettingValue(bad, 'a', 'x').ok && Object.keys(valuesForHandler(bad, { a: 'x' })).length === 0);
  check('and it never needs setup', needsSetup({ settings: 'x' }, {}) === false);
}

console.log('needs setup:');
check('a required field with no default and no value needs setup', needsSetup(SPEC, {}) === true);
check('a value for it clears that', needsSetup(SPEC, { limit: 1 }) === false);
check('a required field with a default never does', needsSetup({ settings: [{ key: 'u', required: true, default: 'x' }] }, {}) === false);
check('a shim without settings never does', needsSetup({}, {}) === false);

console.log('the reboot digest:');
{
  const a = settingsKey(SPEC, { limit: 1 });
  check('present for a shim with settings, 16 hex characters', typeof a === 'string' && /^[0-9a-f]{16}$/.test(a), String(a));
  check('stable for the same values', settingsKey(SPEC, { limit: 1 }) === a);
  check('different when a value changes', settingsKey(SPEC, { limit: 2 }) !== a);
  check('setting a value equal to the default changes nothing a handler reads, so neither does the digest', settingsKey(SPEC, { limit: 1, units: 'metric' }) === a);
  check('a dropped field\'s row does not change it', settingsKey(SPEC, { limit: 1, gone: 'x' }) === a);
  check('absent for a shim without settings', settingsKey({}, { x: 1 }) === undefined);
  check('it carries no value', !String(a).includes('metric'));
}

console.log('');
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log(`all settings checks passed (${passes})`);
