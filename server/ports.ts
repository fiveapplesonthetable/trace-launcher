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

/**
 * Hands out free TCP ports from a fixed `[base, base + count)` range,
 * round-robin so a freed port is not immediately reused. Callers pass the set
 * of ports they already hold so the allocator can skip them without probing.
 */
export class PortAllocator {
  private nextOffset = 0;

  constructor(
    private readonly host: string,
    private readonly base: number,
    private readonly count: number,
  ) {}

  async allocate(inUse: Iterable<number>): Promise<number> {
    const used = new Set(inUse);
    for (let i = 0; i < this.count; i++) {
      const port = this.base + this.nextOffset;
      this.nextOffset = (this.nextOffset + 1) % this.count;
      if (used.has(port)) continue;
      if (await portIsFree(this.host, port)) return port;
    }
    const last = this.base + this.count - 1;
    throw new Error(
      `no free trace_processor port in ${this.host}:${this.base}-${last}`,
    );
  }
}
