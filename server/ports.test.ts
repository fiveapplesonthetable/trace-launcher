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
