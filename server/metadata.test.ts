import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test, type TestContext} from 'node:test';

import Database from 'better-sqlite3';

import {MetadataError, MetadataStore} from './metadata';

/** Builds a small metadata SQLite DB and returns its path. */
function makeDb(t: TestContext): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tl-meta-')));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const dbPath = path.join(dir, 'meta.db');

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE traces (
      path TEXT,
      device TEXT,
      android_version INTEGER,
      duration_ms INTEGER
    );
  `);
  const insert = db.prepare(
    'INSERT INTO traces (path, device, android_version, duration_ms)' +
      ' VALUES (?, ?, ?, ?)',
  );
  insert.run('alpha.pftrace', 'pixel-8', 14, 5000);
  insert.run('beta.perfetto-trace', 'pixel-9', 15, 12000);
  insert.run('/captures/gamma.trace.gz', 'pixel-6', 13, 800);
  db.close();
  return dbPath;
}

function openStore(t: TestContext): MetadataStore {
  const store = new MetadataStore(makeDb(t), 'traces', undefined);
  t.after(() => store.close());
  return store;
}

test('columns reports metadata columns with inferred kinds', (t) => {
  const columns = openStore(t).columns();
  const byId = new Map(columns.map((c) => [c.id, c]));
  assert.equal(byId.get('meta:device')?.kind, 'text');
  assert.equal(byId.get('meta:android_version')?.kind, 'number');
  assert.equal(byId.get('meta:duration_ms')?.kind, 'number');
  assert.ok(columns.every((c) => c.source === 'metadata' && c.filterable));
});

test('lookup joins by exact key and by basename', (t) => {
  const store = openStore(t);
  assert.equal(
    store.lookup({
      abs: '/x/alpha.pftrace',
      rel: 'alpha.pftrace',
      name: 'alpha.pftrace',
    })?.device,
    'pixel-8',
  );
  // The DB stores an absolute path; a trace addressed by basename still joins.
  assert.equal(
    store.lookup({
      abs: '/elsewhere/gamma.trace.gz',
      rel: 'gamma.trace.gz',
      name: 'gamma.trace.gz',
    })?.device,
    'pixel-6',
  );
  assert.equal(
    store.lookup({abs: '/x/none.pftrace', rel: 'none.pftrace', name: 'none.pftrace'}),
    undefined,
  );
});

test('filterKeys returns null when there are no metadata filters', (t) => {
  assert.equal(openStore(t).filterKeys([]), null);
});

test('filterKeys runs text and numeric predicates through SQL', (t) => {
  const store = openStore(t);

  const byDevice = store.filterKeys([
    {column: 'meta:device', op: 'equals', value: 'pixel-9'},
  ]);
  assert.equal(byDevice?.has('beta.perfetto-trace'), true);
  assert.equal(byDevice?.has('alpha.pftrace'), false);

  const longTraces = store.filterKeys([
    {column: 'meta:duration_ms', op: 'gte', value: '5000'},
  ]);
  assert.equal(longTraces?.has('alpha.pftrace'), true);
  assert.equal(longTraces?.has('beta.perfetto-trace'), true);
  assert.equal(longTraces?.has('gamma.trace.gz'), false);
});

test('filterKeys combines multiple filters with AND', (t) => {
  const matched = openStore(t).filterKeys([
    {column: 'meta:android_version', op: 'gte', value: '14'},
    {column: 'meta:duration_ms', op: 'lt', value: '10000'},
  ]);
  assert.equal(matched?.has('alpha.pftrace'), true);
  assert.equal(matched?.has('beta.perfetto-trace'), false); // 12000ms, excluded
});

test('filterKeys rejects a non-numeric value for a numeric column', (t) => {
  assert.throws(
    () =>
      openStore(t).filterKeys([
        {column: 'meta:duration_ms', op: 'gt', value: 'soon'},
      ]),
    MetadataError,
  );
});

test('suggest returns distinct, prefix-matched values', (t) => {
  const store = openStore(t);
  assert.deepEqual(
    [...store.suggest('meta:device', 'pixel-')].sort(),
    ['pixel-6', 'pixel-8', 'pixel-9'],
  );
  assert.deepEqual(store.suggest('meta:device', 'nexus'), []);
});

test('constructor rejects an unknown table or key column', (t) => {
  const dbPath = makeDb(t);
  assert.throws(() => new MetadataStore(dbPath, 'nope', undefined), MetadataError);
  assert.throws(
    () => new MetadataStore(dbPath, 'traces', 'not_a_column'),
    MetadataError,
  );
});
