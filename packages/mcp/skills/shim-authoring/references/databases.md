# Databases: `api.db` and remote connections

Part of the shim-authoring guide (read `SKILL.md` and `references/api.md` first). Read this when a shim or composition declares `storage` or `connections`.

**`api.db`** — the shim's own SQLite database, for data with real shape (many rows to
filter, sort, count). Declare tables in `storage`:

```json
"storage": { "tables": [{ "name": "plays", "columns": [
  { "name": "id", "type": "integer", "primaryKey": true },
  { "name": "track_id", "type": "text", "notNull": true },
  { "name": "played_at", "type": "integer", "notNull": true }
], "indexes": [{ "name": "plays_track_idx", "columns": ["track_id"] }] }] }
```

Names are lowercase `snake_case`; types `text | integer | real | blob`. A column may also
set `"unique": true` and a `"default"` (a string, number or `null`); an index may set
`"unique": true`, over one column or several. Additive changes apply on commit, with two
limits. A column added to an existing table can't be `unique` or `primaryKey`: add a
unique index instead. It can't be `notNull` without a non-null `default` either. Such a
column is skipped with a note.

To record something once (one row per item per day, say), let a unique index enforce it
and write with `INSERT OR IGNORE`, or with
`INSERT … ON CONFLICT(cols) DO UPDATE SET …` to keep the latest. Both are plain writes, so
they never ask:

```json
{ "name": "price_points", "columns": [
  { "name": "asin", "type": "text", "notNull": true },
  { "name": "day", "type": "text", "notNull": true },
  { "name": "price", "type": "real" },
  { "name": "seen_at", "type": "integer", "notNull": true, "default": 0 }
], "indexes": [{ "name": "price_points_once", "columns": ["asin", "day"], "unique": true }] }
```

```js
await api.db.run('INSERT OR IGNORE INTO price_points (asin, day, price, seen_at) VALUES (?, ?, ?, ?)',
  [asin, day, price, Date.now()]);
```

A unique index can't be created over rows that already break it: dedupe them first. Then `await api.db.query(sql, params)` (reads only; `{ ok, rows,
truncated? }`, capped by default at 5,000 rows / 1 MB; a shim that really needs bigger
reads raises its own caps with `"storage": { "limits": { "maxRows": 20000,
"maxResultBytes": 5000000 }, "tables": [...] }`, up to 100,000 rows / 20 MB — prefer
`LIMIT`/`OFFSET` paging or an aggregate first) and `await api.db.run(sql, params)` (writes
and DDL; `{ ok, changes, lastInsertRowid }`). Parameterized (`?`) only, one statement per
call. Destructive DDL waits on the user's approval. Errors to handle: `not-declared`,
`approval-required`, `denied`, `classification: …`, `rejected: …`, `sqlite: …`,
`bad-params: …`. A call takes at most 100 bound parameters (`bad-params: more than 100
params`), so a multi-row `INSERT … VALUES (?, ?, ?), (…)` has to be split into batches
(20 rows of 4 columns is 80). **`api.db` is absent while previewing**: your preview shows the
handler's `api.db &&` fallback. After `shim_commit` the committed rules have it on the
same tab, so verify the data path there (`references/api.md`).
**Remote databases** — `connections: [{ "name": "warehouse", "engine": "postgres" }]`
(`postgres | mysql | mariadb | mssql | sqlite-remote | supabase`) names a database the
user already runs; they paste its URL into the shim's Settings, never you. Each entry
may nest a `storage` of the same `{ "tables": [...] }` shape as the shim's own:

```json
"connections": [{ "name": "warehouse", "engine": "postgres", "storage": { "tables": [
  { "name": "track_notes", "columns": [
    { "name": "id", "type": "integer", "primaryKey": true },
    { "name": "body", "type": "text" }] }] } }]
```

On the SQL engines Shim creates missing tables and columns from it, additively, when the
shim first touches the connection — declare the schema there rather than running DDL
yourself. It is also the table allowlist: once a connection declares a table, a
statement touching an undeclared one (on `postgres | mysql | mariadb | mssql`) waits on
the user's approval, so declare every table you use. Omit `storage` to talk to an
existing schema as is. Reach a connection with
`api.db.connection("warehouse").query(…)` / `.run(…)`; unconfigured, calls answer
`not-configured`. A `supabase` connection instead takes a supabase-js-like builder;
only this subset of it exists:
- start: `.from(table)` then one of `.select(columns?)`, `.insert(row | rows)`,
  `.upsert(row | rows, { onConflict? })`, `.update(patch)`, `.delete()`;
- filters: `.eq` `.neq` `.gt` `.gte` `.lt` `.lte` `.like` `.ilike` `(column, value)`,
  `.in(column, values)`, `.is(column, value)`, `.not(column, op, value)`, `.or("a.eq.1,b.gt.2")`;
- read modifiers: `.order(column, { ascending? })`, `.limit(n)`, `.range(from, to)`,
  `.single()`, `.maybeSingle()`; after a write, `.select(columns?)` returns the
  affected rows. Writes take at most 1,000 rows.

Columns are plain names (or `*`) — no embedded relations, `->` or `::`. A read answers
`{ ok, rows, truncated? }`; a write `{ ok, changes }`, plus `rows` when it ends in
`.select()` — never supabase-js's `{ data, error }`. Row-level security can filter a
write to nothing and still answer `ok` with `changes: 0`, so check `changes`. An
`update`/`delete` with no filter waits on the user's approval. A supabase connection's
`storage` creates nothing — the user makes tables in their Supabase project — but it is
still the table allowlist, so declare every table the shim touches. A new
connection asks the user at commit. Treat remote data as shared: additive changes only,
and say so before writing.
