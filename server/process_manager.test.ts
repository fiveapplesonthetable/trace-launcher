import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {test, type TestContext} from 'node:test';

import {Catalog} from './catalog';
import {ProcessManager} from './process_manager';

function tmpDir(t: TestContext, prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}

/** Writes an executable shell script and returns its path. */
function writeBin(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, {mode: 0o755});
  return file;
}

interface Harness {
  readonly manager: ProcessManager;
  readonly root: string;
  /** Creates a trace file under the root and returns its path. */
  addTrace(name: string): string;
}

/** Spins up a ProcessManager backed by a fake trace_processor binary. */
function setup(t: TestContext, binBody: string): Harness {
  const dir = tmpDir(t, 'tl-pm-');
  const bin = writeBin(dir, 'fake-tp', binBody);
  const catalog = new Catalog(dir, [], 5000, false);
  const manager = new ProcessManager(bin, catalog, '127.0.0.1', 47000, 64);
  t.after(() => manager.stopAll());
  return {
    manager,
    root: dir,
    addTrace(name: string): string {
      const file = path.join(dir, name);
      fs.writeFileSync(file, `bytes:${name}`);
      return file;
    },
  };
}

test('ensureChild spawns a tracked child', async (t) => {
  const {manager, addTrace} = setup(t, 'exec sleep 30');
  const trace = addTrace('sample.pftrace');

  await manager.ensureChild(trace);
  const snapshot = await manager.snapshot();

  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0]?.status, 'starting'); // the fake never binds a port
  assert.ok((snapshot[0]?.pid ?? 0) > 0);
  assert.equal(snapshot[0]?.key, trace);
});

test('ensureChild is idempotent for the same trace', async (t) => {
  const {manager, addTrace} = setup(t, 'exec sleep 30');
  const trace = addTrace('sample.pftrace');

  await manager.ensureChild(trace);
  const firstPid = (await manager.snapshot())[0]?.pid;
  await manager.ensureChild(trace);
  const snapshot = await manager.snapshot();

  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0]?.pid, firstPid);
});

test('distinct traces get distinct ports', async (t) => {
  const {manager, addTrace} = setup(t, 'exec sleep 30');

  await manager.ensureChild(addTrace('one.pftrace'));
  await manager.ensureChild(addTrace('two.pftrace'));
  const snapshot = await manager.snapshot();

  assert.equal(snapshot.length, 2);
  assert.notEqual(snapshot[0]?.port, snapshot[1]?.port);
});

test('stop terminates a live child and is safe to repeat', async (t) => {
  const {manager, addTrace} = setup(t, 'exec sleep 30');
  const trace = addTrace('sample.pftrace');

  await manager.ensureChild(trace);
  assert.equal(manager.stop(trace), true);
  assert.equal((await manager.snapshot()).length, 0);
  assert.equal(manager.stop(trace), false); // already gone
});

test('a child that exits on its own is reported as crashed', async (t) => {
  const {manager, addTrace} = setup(t, 'exit 3');
  const trace = addTrace('flaky.pftrace');

  await manager.ensureChild(trace);
  await sleep(250); // let the process exit and the handler run

  const snapshot = await manager.snapshot();
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0]?.status, 'crashed');
  assert.equal(snapshot[0]?.exit?.code, 3);
  assert.equal(snapshot[0]?.rssBytes, 0);
});

test('stop dismisses a crashed child', async (t) => {
  const {manager, addTrace} = setup(t, 'exit 1');
  const trace = addTrace('flaky.pftrace');

  await manager.ensureChild(trace);
  await sleep(250);
  assert.equal((await manager.snapshot())[0]?.status, 'crashed');

  assert.equal(manager.stop(trace), true);
  assert.equal((await manager.snapshot()).length, 0);
});

test('ensureChild replaces a crashed child on retry', async (t) => {
  const {manager, addTrace} = setup(t, 'exit 1');
  const trace = addTrace('flaky.pftrace');

  await manager.ensureChild(trace);
  await sleep(250);
  const crashedPid = (await manager.snapshot())[0]?.pid;

  await manager.ensureChild(trace); // retry
  const snapshot = await manager.snapshot();
  assert.equal(snapshot.length, 1);
  assert.notEqual(snapshot[0]?.pid, crashedPid);
});

test('stopAll reaps every child', async (t) => {
  const {manager, addTrace} = setup(t, 'exec sleep 30');

  await manager.ensureChild(addTrace('one.pftrace'));
  await manager.ensureChild(addTrace('two.pftrace'));

  assert.equal(manager.stopAll(), 2);
  assert.equal((await manager.snapshot()).length, 0);
});
