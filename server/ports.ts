import net from 'node:net';

// TCP port helpers for managing the pool of backend trace_processor_shell
// servers. Each child binds one port; this module decides which.

/** Resolves true if `port` can currently be bound on `host`. */
export function portIsFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

/** Resolves true if something is already accepting connections on the port. */
export function portIsOpen(
  host: string,
  port: number,
  timeoutMs = 120,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const finish = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

/** Thrown by the allocator when every port in the range is taken. */
export class OutOfPortsError extends Error {
  readonly code = 'OUT_OF_PORTS';
}

/**
 * Hands out free TCP ports from a fixed `[base, base + count)` range,
 * round-robin so a freed port is not immediately reused. Callers pass the set
 * of ports they already hold so the allocator can skip them without probing.
 *
 * Allocation is serialised: two concurrent allocate() calls won't probe the
 * same port and both win the race. The mutex is a simple promise chain — at
 * the rates this server runs at (a click per second at most), the queueing
 * cost is unmeasurable.
 */
export class PortAllocator {
  private nextOffset = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly host: string,
    private readonly base: number,
    private readonly count: number,
  ) {}

  allocate(inUse: Iterable<number>): Promise<number> {
    const next = this.chain.then(() => this.allocateOne(new Set(inUse)));
    // Keep the chain alive even if this attempt rejects; subsequent callers
    // must still get a fair shot at the allocator.
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async allocateOne(used: Set<number>): Promise<number> {
    for (let i = 0; i < this.count; i++) {
      const port = this.base + this.nextOffset;
      this.nextOffset = (this.nextOffset + 1) % this.count;
      if (used.has(port)) continue;
      if (await portIsFree(this.host, port)) return port;
    }
    const last = this.base + this.count - 1;
    throw new OutOfPortsError(
      `no free trace_processor port in ${this.host}:${this.base}-${last} — ` +
        'stop a running trace to free one',
    );
  }
}
