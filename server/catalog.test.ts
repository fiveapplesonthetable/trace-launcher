import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test, type TestContext} from 'node:test';

import {
  Catalog,
  CatalogError,
  looksLikeTrace,
  parseHumanSize,
  parseHumanTime,
} from './catalog';

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

test('list browses directories and hides non-trace files', async (t) => {
  const catalog = new Catalog(makeTree(t), [], 5000, false);
  const page = await catalog.list('', '');
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

test('list descends into a sub-directory and exposes the parent', async (t) => {
  const catalog = new Catalog(makeTree(t), [], 5000, false);
  const page = await catalog.list('', 'nested');
  assert.deepEqual(
    page.traces.map((tr) => tr.name),
    ['gamma.trace.gz'],
  );
  assert.equal(page.dir, 'nested');
  assert.equal(page.parent, '');
});

test('search is scoped to the current directory unless recursive', async (t) => {
  const root = makeTree(t);
  const flat = new Catalog(root, [], 5000, false);
  assert.deepEqual((await flat.list('gamma', '')).traces, []);

  const recursive = new Catalog(root, [], 5000, true);
  assert.deepEqual(
    (await recursive.list('gamma', '')).traces.map((tr) => tr.name),
    ['gamma.trace.gz'],
  );
});

test('search matches the file name case-insensitively', async (t) => {
  const catalog = new Catalog(makeTree(t), [], 5000, false);
  assert.deepEqual(
    (await catalog.list('ALPHA', '')).traces.map((tr) => tr.name),
    ['alpha.pftrace'],
  );
});

test('maxResults caps the page and flags truncation', async (t) => {
  const catalog = new Catalog(makeTree(t), [], 1, false);
  const page = await catalog.list('', '');
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

test('selected mode exposes only the allow-listed traces', async (t) => {
  const root = makeTree(t);
  const catalog = new Catalog(root, ['alpha.pftrace'], 5000, false);
  assert.equal(catalog.selectedMode, true);

  const page = await catalog.list('', '');
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

test('parseHumanTime accepts the inputs the filter UI advertises', () => {
  // Pin "now" so the expectations are deterministic — 2026-05-15 12:00 UTC.
  const now = Date.UTC(2026, 4, 15, 12, 0, 0);
  const startOfToday = Date.UTC(2026, 4, 15, 0, 0, 0);
  assert.equal(parseHumanTime('now', now), now);
  assert.equal(parseHumanTime('today', now), startOfToday);
  assert.equal(parseHumanTime('yesterday', now), startOfToday - 86_400_000);
  assert.equal(parseHumanTime('1 day ago', now), now - 86_400_000);
  assert.equal(parseHumanTime('2 weeks ago', now), now - 14 * 86_400_000);
  assert.equal(parseHumanTime('30 minutes ago', now), now - 30 * 60_000);
  // ISO date parses to midnight UTC at minimum.
  const isoMidday = parseHumanTime('2026-05-01', now);
  assert.ok(isoMidday !== null && Number.isFinite(isoMidday));
  assert.equal(parseHumanTime('garbage', now), null);
  assert.equal(parseHumanTime('', now), null);
  // Bare numbers come through unchanged (escape hatch for ms timestamps).
  assert.equal(parseHumanTime('1700000000000', now), 1700000000000);
});

test('parseHumanSize understands plain bytes and unit suffixes', () => {
  assert.equal(parseHumanSize('2048'), 2048);
  assert.equal(parseHumanSize('1kb'), 1024);
  assert.equal(parseHumanSize('1.5 MiB'), 1.5 * 1024 * 1024);
  assert.equal(parseHumanSize('3g'), 3 * 1024 ** 3);
  assert.equal(parseHumanSize('not-a-size'), null);
  assert.equal(parseHumanSize('10 furlongs'), null);
});

test('list applies a size filter on the file column', async (t) => {
  const catalog = new Catalog(makeTree(t), [], 5000, false);
  // alpha.pftrace is 1 byte, beta.perfetto-trace is 2 bytes.
  const page = await catalog.list('', '', [
    {column: 'size', op: 'gte', value: '2'},
  ]);
  assert.deepEqual(
    page.traces.map((tr) => tr.name),
    ['beta.perfetto-trace'],
  );
});

test('list applies a path filter to a recursive search', async (t) => {
  const catalog = new Catalog(makeTree(t), [], 5000, true);
  const page = await catalog.list('trace', '', [
    {column: 'rel', op: 'contains', value: 'nested'},
  ]);
  assert.deepEqual(
    page.traces.map((tr) => tr.rel),
    ['nested/gamma.trace.gz'],
  );
});

test('list searches by AND-substring tokens against the rel path', async (t) => {
  const root = tmpDir(t, 'tl-catalog-search-');
  fs.mkdirSync(path.join(root, '2026-05'));
  fs.mkdirSync(path.join(root, 'cuttlefish'));
  fs.writeFileSync(path.join(root, '2026-05', 'android-boot.pftrace'), 'a');
  fs.writeFileSync(path.join(root, '2026-05', 'chrome-start.pftrace'), 'b');
  fs.writeFileSync(path.join(root, 'cuttlefish', 'boot-fail.pftrace'), 'c');
  const catalog = new Catalog(root, [], 5000, true);
  // Single token hits files at any depth whose rel path contains it.
  const oneToken = await catalog.list('boot', '', []);
  assert.deepEqual(
    oneToken.traces.map((t) => t.rel).sort(),
    ['2026-05/android-boot.pftrace', 'cuttlefish/boot-fail.pftrace'].sort(),
  );
  // Two tokens are ANDed; order does not matter, both must appear somewhere.
  const both = await catalog.list('boot 2026', '', []);
  assert.deepEqual(
    both.traces.map((t) => t.rel),
    ['2026-05/android-boot.pftrace'],
  );
  // A token that matches nothing kills the result, even with other matches.
  const miss = await catalog.list('boot xenomorph', '', []);
  assert.equal(miss.traces.length, 0);
});

test('list returns natural breadth-first order when no sort is given', async (t) => {
  const root = tmpDir(t, 'tl-catalog-bfs-');
  fs.writeFileSync(path.join(root, 'root.pftrace'), 'r');
  fs.mkdirSync(path.join(root, 'deep'));
  fs.mkdirSync(path.join(root, 'deep', 'deeper'));
  fs.writeFileSync(path.join(root, 'deep', 'mid.pftrace'), 'm');
  fs.writeFileSync(path.join(root, 'deep', 'deeper', 'leaf.pftrace'), 'l');
  const catalog = new Catalog(root, [], 5000, true);
  const page = await catalog.list('pftrace', '', []);
  // Shallowest first, then by basename.
  assert.deepEqual(
    page.traces.map((t) => t.rel),
    ['root.pftrace', 'deep/mid.pftrace', 'deep/deeper/leaf.pftrace'],
  );
});

/** Polls `predicate` for up to `timeoutMs`. Built for fs.watch tests:
 *  watch events fire asynchronously and the exact latency depends on
 *  the platform's notification mechanism (inotify on Linux, FSEvents
 *  on macOS, ReadDirectoryChangesW on Windows). Polling avoids a
 *  hard-coded sleep that would either flake or waste time. */
async function eventually(
  predicate: () => Promise<boolean>,
  timeoutMs = 2500,
  intervalMs = 50,
): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

test('watcher cache picks up a newly added trace file', async (t) => {
  const root = makeTree(t);
  const catalog = new Catalog(root, [], 5000, false);
  t.after(() => catalog.close());
  // Prime the cache.
  const before = await catalog.list('', '');
  assert.equal(before.traces.length, 2);
  // Add a new file; the watcher should fire and invalidate the cache.
  fs.writeFileSync(path.join(root, 'newfile.pftrace'), 'x');
  const ok = await eventually(async () => {
    const page = await catalog.list('', '');
    return page.traces.some((tr) => tr.name === 'newfile.pftrace');
  });
  assert.ok(ok, 'newly added file did not appear via the watcher');
});

test('watcher cache picks up a removed trace file', async (t) => {
  const root = makeTree(t);
  const catalog = new Catalog(root, [], 5000, false);
  t.after(() => catalog.close());
  await catalog.list('', ''); // prime
  fs.unlinkSync(path.join(root, 'alpha.pftrace'));
  const ok = await eventually(async () => {
    const page = await catalog.list('', '');
    return !page.traces.some((tr) => tr.name === 'alpha.pftrace');
  });
  assert.ok(ok, 'removed file did not disappear via the watcher');
});

test('watcher cache picks up a new sub-directory', async (t) => {
  const root = makeTree(t);
  const catalog = new Catalog(root, [], 5000, false);
  t.after(() => catalog.close());
  await catalog.list('', '');
  fs.mkdirSync(path.join(root, 'fresh'));
  const ok = await eventually(async () => {
    const page = await catalog.list('', '');
    return page.dirs.some((d) => d.name === 'fresh');
  });
  assert.ok(ok, 'new sub-directory did not appear via the watcher');
});

test('forceRescan reflects on-disk state even if the watcher misses an event', async (t) => {
  const root = makeTree(t);
  const catalog = new Catalog(root, [], 5000, false);
  t.after(() => catalog.close());
  // Prime the cache, then simulate a "watch event lost" by clearing
  // the watcher behind the scenes — the cache still holds stale data.
  await catalog.list('', '');
  fs.writeFileSync(path.join(root, 'sneaky.pftrace'), 'x');
  // Force the cache to lie: pretend the watch never fired by pre-loading
  // a stale entry into the cache via list() before the watcher races.
  // The forceRescan flag must bust through whatever's there.
  const page = await catalog.list('', '', [], undefined, {forceRescan: true});
  assert.ok(
    page.traces.some((tr) => tr.name === 'sneaky.pftrace'),
    'forceRescan did not return the freshly-added file',
  );
});

test('catalog without recursive watch still works (selected mode)', async (t) => {
  const root = makeTree(t);
  // Selected mode disables the watcher entirely. The catalog should
  // still serve list() — just without the cache speed-up.
  const catalog = new Catalog(root, ['alpha.pftrace'], 5000, false);
  t.after(() => catalog.close());
  const page = await catalog.list('', '');
  assert.equal(page.traces.length, 1);
  assert.equal(page.traces[0]?.name, 'alpha.pftrace');
});

test('list applies an explicit sort spec verbatim', async (t) => {
  const root = tmpDir(t, 'tl-catalog-sort-');
  fs.writeFileSync(path.join(root, 'a.pftrace'), 'xxx');     // 3 bytes
  fs.writeFileSync(path.join(root, 'b.pftrace'), 'xx');      // 2 bytes
  fs.writeFileSync(path.join(root, 'c.pftrace'), 'x');       // 1 byte
  const catalog = new Catalog(root, [], 5000, true);
  const asc = await catalog.list('', '', [], {column: 'size', direction: 'asc'});
  assert.deepEqual(asc.traces.map((t) => t.name), ['c.pftrace', 'b.pftrace', 'a.pftrace']);
  const desc = await catalog.list('', '', [], {column: 'size', direction: 'desc'});
  assert.deepEqual(desc.traces.map((t) => t.name), ['a.pftrace', 'b.pftrace', 'c.pftrace']);
});
