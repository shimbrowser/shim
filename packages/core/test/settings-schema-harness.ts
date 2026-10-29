// Harness for @shimbrowser/core/settings-schema (a shim's settings
// declaration, read the same way by every host):
//
//   - settingsSchemaProblems lists every problem (not an array, a non-object
//     field, a bad or duplicate key, an unknown type, a select without
//     options) and none for a valid or absent declaration;
//   - validateSchema throws code bad_settings_schema with those problems and
//     the shape a field takes, and nothing for a valid one;
//   - normalizeSchema fills label (the key when blank), type (text), required,
//     help, and stringifies a select's options;
//   - secretSettingKeys names the secret fields, defensively on a raw
//     declaration;
//   - a secret field's `use` (D17) validates strictly: exactly one of header
//     and query, a canonical https origin, a safe header or query name, one
//     `{}` in a bounded, well-formed format, no unknown keys, no default;
//     secretSettingPlacements splits placed from plain secrets.
//
//   node out/packages/core/test/settings-schema-harness.js

import { settingsSchemaProblems, validateSchema, normalizeSchema, secretSettingKeys, effectiveFieldType, credentialUseProblems, secretSettingPlacements, credentialHeaderAllowed, hasLoneSurrogate } from '../src/settings-schema';

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function thrown(fn: () => void): (Error & { code?: string }) | null {
  try { fn(); return null; } catch (e) { return e as Error & { code?: string }; }
}

console.log('problems');
{
  check('no declaration has none', settingsSchemaProblems({}).length === 0 && settingsSchemaProblems(null).length === 0 && settingsSchemaProblems({ settings: null }).length === 0);
  check('an empty list has none', settingsSchemaProblems({ settings: [] }).length === 0);
  check('a valid declaration has none', settingsSchemaProblems({ settings: [
    { key: 'units', type: 'select', options: ['metric', 'imperial'] }, { key: 'n', type: 'number' }, { key: 'on', type: 'boolean' }, { key: 'note' }, { key: 'tok', type: 'secret' },
  ] }).length === 0);
  const notArray = settingsSchemaProblems({ settings: { key: 'a' } }, 'manifest');
  check('not an array is one problem, labelled', notArray.length === 1 && notArray[0] === 'manifest.settings must be an array of field declarations (or omitted)', notArray.join('|'));
  const many = settingsSchemaProblems({ settings: [null, { key: 'bad key' }, { key: 'a' }, { key: 'a' }, { key: 'b', type: 'string' }, { key: 'c', type: 'select' }, { key: 'd', type: 'select', options: [] }] });
  check('every problem is listed, by field', many.length === 6
    && many[0] === 'settings[0]: not an object'
    && many[1]?.includes('settings[1]: `key` must be an identifier') === true
    && many[2] === 'settings[3]: duplicate key "a"'
    && many[3]?.includes('settings[4]: `type` "string" is not one of') === true
    && many[4]?.includes('settings[5]: a "select" field needs') === true
    && many[5]?.includes('settings[6]: a "select" field needs') === true, many.join(' | '));
}

console.log('validateSchema');
{
  check('a valid declaration does not throw', thrown(() => validateSchema({ settings: [{ key: 'a' }] })) === null);
  check('no declaration does not throw', thrown(() => validateSchema({ id: 'x', match: { hosts: [] }, rules: [] })) === null);
  const bad = thrown(() => validateSchema({ settings: [{ key: 'a' }, { key: 'a' }] }));
  check('a bad one throws bad_settings_schema, with the problem and the field shape', bad?.code === 'bad_settings_schema'
    && bad.message.startsWith('invalid settings schema: settings[1]: duplicate key "a"') && bad.message.includes('{ key, label, type:'), bad?.message);
  const notArray = thrown(() => validateSchema({ settings: 'x' }));
  check('not an array throws that one line alone', notArray?.code === 'bad_settings_schema' && notArray.message === 'spec.settings must be an array of field declarations (or omitted)', notArray?.message);
}

console.log('normalizeSchema');
{
  const [a, b, c] = normalizeSchema({ settings: [
    { key: 'units', label: 'Units', type: 'select', options: [1, 'two'], required: 1, help: 'h', default: 'two' },
    { key: 'plain', label: '   ' },
    { key: 'weird', type: 'nope' },
  ] });
  check('a full field normalizes as declared, options as strings', a?.label === 'Units' && a.type === 'select' && a.required === true && a.help === 'h'
    && JSON.stringify(a.options) === '["1","two"]' && a.default === 'two', JSON.stringify(a));
  check('a blank label falls back to the key, no type is text, not required, no help', b?.label === 'plain' && b.type === 'text' && b.required === false && b.help === '' && b.options === undefined);
  check('an unknown type reads as text (the runtime\'s reading)', c?.type === 'text' && effectiveFieldType('nope') === 'text');
  check('no declaration normalizes to no fields', normalizeSchema({}).length === 0);
}

console.log('secretSettingKeys');
{
  check('names the secret fields in order', JSON.stringify(secretSettingKeys({ settings: [{ key: 'a' }, { key: 'tok', type: 'secret' }, { key: 'p', type: 'secret' }] })) === '["tok","p"]');
  check('a raw, unvalidated declaration is read defensively', JSON.stringify(secretSettingKeys({ settings: [null, 3, { type: 'secret' }] })) === '["?"]');
  check('none when there is no list', secretSettingKeys({ settings: 'x' }).length === 0 && secretSettingKeys(undefined).length === 0);
}

console.log('use (D17)');
{
  const H = { origin: 'https://api.example.com', header: 'Authorization', format: 'Bearer {}' };
  const Q = { origin: 'https://maps.example.com', query: 'key', format: '{}' };
  check('a header use is valid', credentialUseProblems(H).length === 0, credentialUseProblems(H).join(' | '));
  check('a query use is valid', credentialUseProblems(Q).length === 0);
  check('a non-default port is part of the origin', credentialUseProblems({ ...Q, origin: 'https://maps.example.com:8443' }).length === 0);
  const bad: Array<[string, unknown]> = [
    ['not an object', 'https://x.test'],
    ['both header and query', { ...H, query: 'key' }],
    ['neither header nor query', { origin: H.origin, format: '{}' }],
    ['an unknown property', { ...H, method: 'POST' }],
    ['http', { ...H, origin: 'http://api.example.com' }],
    ['a trailing slash', { ...H, origin: 'https://api.example.com/' }],
    ['a path', { ...H, origin: 'https://api.example.com/v1' }],
    ['userinfo', { ...H, origin: 'https://u:p@api.example.com' }],
    ['upper-case host (not canonical)', { ...H, origin: 'https://API.example.com' }],
    ['an explicit default port (not canonical)', { ...H, origin: 'https://api.example.com:443' }],
    ['a unicode host (not punycode)', { ...H, origin: 'https://bücher.example' }],
    ['a wildcard', { ...H, origin: 'https://*.example.com' }],
    ['a private address', { ...H, origin: 'https://127.0.0.1' }],
    ['localhost', { ...H, origin: 'https://localhost' }],
    ['a forbidden header', { ...H, header: 'Cookie' }],
    ['a hop-by-hop header', { ...H, header: 'Connection' }],
    ['a sec- header', { ...H, header: 'Sec-Fetch-Site' }],
    ['a proxy- header', { ...H, header: 'Proxy-Authorization' }],
    ['a body header', { ...H, header: 'Content-Type' }],
    ['a header name with a space', { ...H, header: 'X Api Key' }],
    ['a query name with "="', { ...Q, query: 'k=y' }],
    ['a query name with "&"', { ...Q, query: 'a&b' }],
    ['an empty query name', { ...Q, query: '' }],
    ['no slot', { ...H, format: 'Bearer' }],
    ['two slots', { ...H, format: '{}{}' }],
    ['a long format', { ...Q, format: '{}' + 'x'.repeat(300) }],
    ['a lone surrogate', { ...Q, format: '{}\uD800' }],
    ['CR/LF in a header format', { ...H, format: 'Bearer {}\r\nX-Evil: 1' }],
    ['a non-latin1 header format', { ...H, format: 'Bearer {} ✓' }],
  ];
  for (const [label, use] of bad) check(`refused: ${label}`, credentialUseProblems(use).length > 0);
  check('header names compare case-insensitively', credentialHeaderAllowed('x-api-key') && credentialHeaderAllowed('X-API-KEY') && !credentialHeaderAllowed('COOKIE'));
  check('lone surrogates are detected, pairs are not', hasLoneSurrogate('a\uDC00') && !hasLoneSurrogate('a\uD83D\uDE00'));

  const ok = settingsSchemaProblems({ settings: [{ key: 'k', type: 'secret', use: H }] });
  check('a secret field with a valid use is a valid declaration', ok.length === 0, ok.join(' | '));
  const probs = settingsSchemaProblems({ settings: [
    { key: 'a', type: 'text', use: H },
    { key: 'b', type: 'secret', use: H, default: 'x' },
    { key: 'c', type: 'secret', use: { ...H, origin: 'http://x.test' } },
  ] });
  check('use on a non-secret field, a default beside use, and a bad use are each named',
    probs.some((p) => p.startsWith('settings[0]: only a "secret"')) && probs.some((p) => p.startsWith('settings[1]: a secret field with `use` may not have a `default`'))
      && probs.some((p) => p.startsWith('settings[2]: `use.origin`')), probs.join(' | '));
  check('a plain secret may still carry a default (unchanged)', settingsSchemaProblems({ settings: [{ key: 'p', type: 'secret', default: 'x' }] }).length === 0);
  const [n1, n2] = normalizeSchema({ settings: [{ key: 'k', type: 'secret', use: H }, { key: 'p', type: 'secret' }] });
  check('normalizeSchema carries a valid use, and none for a plain secret', JSON.stringify(n1?.use) === JSON.stringify(H) && n2?.use === undefined);
  const sp = secretSettingPlacements({ settings: [{ key: 'k', type: 'secret', use: H }, { key: 'p', type: 'secret' }, { key: 'x', type: 'secret', use: { origin: 'nope' } }, { key: 't' }] });
  check('secretSettingPlacements splits placed from plain, an invalid use reading as plain', JSON.stringify(sp) === '{"placed":["k"],"plain":["p","x"]}', JSON.stringify(sp));
}

if (failures) { console.error(`\n${failures} settings-schema check(s) failed`); process.exit(1); }
console.log('\nall settings-schema checks passed');
