import assert from 'node:assert/strict';
import net from 'node:net';
import {test} from 'node:test';

import {PortAllocator, portIsFree, portIsOpen} from './ports';

test('portIsFree / portIsOpen agree with the kernel', async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const {port} = address;

  assert.equal(await portIsFree('127.0.0.1', port), false);
  assert.equal(await portIsOpen('127.0.0.1', port), true);

  await new Promise<void>((resolve) => server.close(() => resolve()));

  assert.equal(await portIsFree('127.0.0.1', port), true);
  assert.equal(await portIsOpen('127.0.0.1', port), false);
});

test('PortAllocator hands out a port in range and skips ones in use', async () => {
  const allocator = new PortAllocator('127.0.0.1', 53000, 8);
  const first = await allocator.allocate([]);
  assert.ok(first >= 53000 && first < 53008);

  const second = await allocator.allocate([first]);
  assert.notEqual(second, first);
  assert.ok(second >= 53000 && second < 53008);
});

test('PortAllocator throws when the whole range is taken', async () => {
  const allocator = new PortAllocator('127.0.0.1', 53100, 2);
  await assert.rejects(() => allocator.allocate([53100, 53101]));
});

test('PortAllocator throws OutOfPortsError with code OUT_OF_PORTS', async () => {
  const allocator = new PortAllocator('127.0.0.1', 53200, 1);
  await assert.rejects(
    () => allocator.allocate([53200]),
    (err: unknown) => {
      // Don't import OutOfPortsError here — the stable contract is the code
      // string, which the API layer maps to HTTP 409.
      assert.ok(err instanceof Error);
      assert.equal((err as {code?: string}).code, 'OUT_OF_PORTS');
      return true;
    },
  );
});

test('PortAllocator serialises concurrent allocations — never the same port twice', async () => {
  // Without the serialising chain in allocate(), two concurrent callers can
  // both win the same port: A probes free, B probes free, both return it,
  // and one of the two spawns fails to bind. The chain prevents that race
  // entirely; this test would deadlock or duplicate without it.
  const allocator = new PortAllocator('127.0.0.1', 53300, 32);
  const handed = await Promise.all(
    Array.from({length: 16}, () => allocator.allocate([])),
  );
  assert.equal(new Set(handed).size, handed.length);
});

test('PortAllocator chain survives a rejection and serves subsequent callers', async () => {
  // The first allocate exhausts the (single-port) range and rejects. The
  // second must still be able to claim the same port via a fresh `inUse`
  // set — proving the internal chain wasn't poisoned by the rejection.
  const allocator = new PortAllocator('127.0.0.1', 53400, 1);
  await assert.rejects(() => allocator.allocate([53400]));
  const port = await allocator.allocate([]);
  assert.equal(port, 53400);
});
