import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test, type TestContext} from 'node:test';

import {Catalog, CatalogError, looksLikeTrace, parseHumanSize} from './catalog';

function tmpDir(t: TestContext, prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}

/** Builds a small traces tree and returns its root. */
function makeTree(t: TestContext): string {
  const root = tmpDir(t, 'tl-catalog-');
  fs.writeFileSync(path.join(root, 'alpha.pftrace'), 'a');
  fs.writeFileSync(path.join(root, 'beta.perfetto-trace'), 'bb');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'ignore me');
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'nested', 'gamma.trace.gz'), 'ccc');
  return root;
}

test('looksLikeTrace recognises trace suffixes only', () => {
  assert.equal(looksLikeTrace('boot.pftrace'), true);
  assert.equal(looksLikeTrace('boot.perfetto-trace.gz'), true);
  assert.equal(looksLikeTrace('BOOT.TRACE'), true);
  assert.equal(looksLikeTrace('boot.txt'), false);
  assert.equal(looksLikeTrace('pftrace'), false);
});

test('list browses directories and hides non-trace files', (t) => {
  const catalog = new Catalog(makeTree(t), [], 5000, false);
  const page = catalog.list('', '');
  assert.deepEqual(
    page.dirs.map((d) => d.name),
    ['nested'],
  );
  assert.deepEqual(
    page.traces.map((tr) => tr.name),
    ['alpha.pftrace', 'beta.perfetto-trace'],
  );
  assert.equal(page.totalSize, 3); // 'a' + 'bb'
  assert.equal(page.parent, null);
  assert.equal(page.dir, '');
});

test('list descends into a sub-directory and exposes the parent', (t) => {
  const catalog = new Catalog(makeTree(t), [], 5000, false);
  const page = catalog.list('', 'nested');
  assert.deepEqual(
    page.traces.map((tr) => tr.name),
    ['gamma.trace.gz'],
  );
  assert.equal(page.dir, 'nested');
  assert.equal(page.parent, '');
});

test('search is scoped to the current directory unless recursive', (t) => {
  const root = makeTree(t);
  const flat = new Catalog(root, [], 5000, false);
  assert.deepEqual(flat.list('gamma', '').traces, []);

  const recursive = new Catalog(root, [], 5000, true);
  assert.deepEqual(
    recursive.list('gamma', '').traces.map((tr) => tr.name),
    ['gamma.trace.gz'],
  );
});

test('search matches the file name case-insensitively', (t) => {
  const catalog = new Catalog(makeTree(t), [], 5000, false);
  assert.deepEqual(
    catalog.list('ALPHA', '').traces.map((tr) => tr.name),
    ['alpha.pftrace'],
  );
});

test('maxResults caps the page and flags truncation', (t) => {
  const catalog = new Catalog(makeTree(t), [], 1, false);
  const page = catalog.list('', '');
  assert.equal(page.traces.length, 1);
  assert.equal(page.truncated, true);
});

test('validate rejects paths outside the root, missing, or non-traces', (t) => {
  const root = makeTree(t);
  const outside = tmpDir(t, 'tl-outside-');
  fs.writeFileSync(path.join(outside, 'evil.pftrace'), 'x');
  const catalog = new Catalog(root, [], 5000, false);

  assert.throws(
    () => catalog.validate(path.join(outside, 'evil.pftrace')),
    CatalogError,
  );
  assert.throws(
    () => catalog.validate(path.join(root, 'missing.pftrace')),
    CatalogError,
  );
  assert.throws(() => catalog.validate(path.join(root, 'notes.txt')), CatalogError);
});

test('validate accepts and canonicalises a real trace under the root', (t) => {
  const root = makeTree(t);
  const catalog = new Catalog(root, [], 5000, false);
  const resolved = catalog.validate(path.join(root, 'alpha.pftrace'));
  assert.equal(resolved, path.join(root, 'alpha.pftrace'));
});

test('selected mode exposes only the allow-listed traces', (t) => {
  const root = makeTree(t);
  const catalog = new Catalog(root, ['alpha.pftrace'], 5000, false);
  assert.equal(catalog.selectedMode, true);

  const page = catalog.list('', '');
  assert.deepEqual(
    page.traces.map((tr) => tr.name),
    ['alpha.pftrace'],
  );
  assert.equal(page.dirs.length, 0);
  assert.throws(
    () => catalog.validate(path.join(root, 'beta.perfetto-trace')),
    CatalogError,
  );
});

test('parseHumanSize understands plain bytes and unit suffixes', () => {
  assert.equal(parseHumanSize('2048'), 2048);
  assert.equal(parseHumanSize('1kb'), 1024);
  assert.equal(parseHumanSize('1.5 MiB'), 1.5 * 1024 * 1024);
  assert.equal(parseHumanSize('3g'), 3 * 1024 ** 3);
  assert.equal(parseHumanSize('not-a-size'), null);
  assert.equal(parseHumanSize('10 furlongs'), null);
});

test('list applies a size filter on the file column', (t) => {
  const catalog = new Catalog(makeTree(t), [], 5000, false);
  // alpha.pftrace is 1 byte, beta.perfetto-trace is 2 bytes.
  const page = catalog.list('', '', [
    {column: 'size', op: 'gte', value: '2'},
  ]);
  assert.deepEqual(
    page.traces.map((tr) => tr.name),
    ['beta.perfetto-trace'],
  );
});

test('list applies a path filter to a recursive search', (t) => {
  const catalog = new Catalog(makeTree(t), [], 5000, true);
  const page = catalog.list('trace', '', [
    {column: 'rel', op: 'contains', value: 'nested'},
  ]);
  assert.deepEqual(
    page.traces.map((tr) => tr.rel),
    ['nested/gamma.trace.gz'],
  );
});

test('list searches by AND-substring tokens against the rel path', (t) => {
  const root = tmpDir(t, 'tl-catalog-search-');
  fs.mkdirSync(path.join(root, '2026-05'));
  fs.mkdirSync(path.join(root, 'cuttlefish'));
  fs.writeFileSync(path.join(root, '2026-05', 'android-boot.pftrace'), 'a');
  fs.writeFileSync(path.join(root, '2026-05', 'chrome-start.pftrace'), 'b');
  fs.writeFileSync(path.join(root, 'cuttlefish', 'boot-fail.pftrace'), 'c');
  const catalog = new Catalog(root, [], 5000, true);
  // Single token hits files at any depth whose rel path contains it.
  const oneToken = catalog.list('boot', '', []);
  assert.deepEqual(
    oneToken.traces.map((t) => t.rel).sort(),
    ['2026-05/android-boot.pftrace', 'cuttlefish/boot-fail.pftrace'].sort(),
  );
  // Two tokens are ANDed; order does not matter, both must appear somewhere.
  const both = catalog.list('boot 2026', '', []);
  assert.deepEqual(
    both.traces.map((t) => t.rel),
    ['2026-05/android-boot.pftrace'],
  );
  // A token that matches nothing kills the result, even with other matches.
  const miss = catalog.list('boot xenomorph', '', []);
  assert.equal(miss.traces.length, 0);
});

test('list returns natural breadth-first order when no sort is given', (t) => {
  const root = tmpDir(t, 'tl-catalog-bfs-');
  fs.writeFileSync(path.join(root, 'root.pftrace'), 'r');
  fs.mkdirSync(path.join(root, 'deep'));
  fs.mkdirSync(path.join(root, 'deep', 'deeper'));
  fs.writeFileSync(path.join(root, 'deep', 'mid.pftrace'), 'm');
  fs.writeFileSync(path.join(root, 'deep', 'deeper', 'leaf.pftrace'), 'l');
  const catalog = new Catalog(root, [], 5000, true);
  const page = catalog.list('pftrace', '', []);
  // Shallowest first, then by basename.
  assert.deepEqual(
    page.traces.map((t) => t.rel),
    ['root.pftrace', 'deep/mid.pftrace', 'deep/deeper/leaf.pftrace'],
  );
});

test('list applies an explicit sort spec verbatim', (t) => {
  const root = tmpDir(t, 'tl-catalog-sort-');
  fs.writeFileSync(path.join(root, 'a.pftrace'), 'xxx');     // 3 bytes
  fs.writeFileSync(path.join(root, 'b.pftrace'), 'xx');      // 2 bytes
  fs.writeFileSync(path.join(root, 'c.pftrace'), 'x');       // 1 byte
  const catalog = new Catalog(root, [], 5000, true);
  const asc = catalog.list('', '', [], {column: 'size', direction: 'asc'});
  assert.deepEqual(asc.traces.map((t) => t.name), ['c.pftrace', 'b.pftrace', 'a.pftrace']);
  const desc = catalog.list('', '', [], {column: 'size', direction: 'desc'});
  assert.deepEqual(desc.traces.map((t) => t.name), ['a.pftrace', 'b.pftrace', 'c.pftrace']);
});
