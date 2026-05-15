import {spawn} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';

import type {ChildExit, PrewarmStatus, RunningChild} from '../shared/types';
import type {Catalog} from './catalog';
import {PortAllocator, portIsOpen} from './ports';
import type {Prewarmer} from './prewarmer';
import {processRss} from './system';

// The process manager owns every trace_processor_shell child: it spawns them,
// allocates their ports, tracks their lifecycle, and reaps them on shutdown.
// It is the only part of the server allowed to touch child processes.

/** A crashed child lingers this long so the UI can show what happened. */
const CRASH_TTL_MS = 60_000;
/** Grace period between SIGTERM and SIGKILL when stopping a child. */
const KILL_GRACE_MS = 5_000;
/** How long the prewarm worker will wait for the trace_processor port to open. */
const PREWARM_PORT_WAIT_MS = 30_000;

interface Child {
  readonly trace: string;
  readonly port: number;
  readonly pid: number;
  readonly proc: ChildProcess;
  readonly startedMs: number;
  /** True once we have asked this child to stop; suppresses crash reporting. */
  stopping: boolean;
  /** Set once the process exits; null while it is still running. */
  exit: ChildExit | null;
  /** Prewarm task state; null until a prewarm has been requested. */
  prewarm: PrewarmStatus | null;
  prewarmError: string | null;
}

/** Deep link that opens a child's RPC port in ui.perfetto.dev. */
function perfettoUrl(port: number): string {
  return `https://ui.perfetto.dev/?rpc_port=${port}#!/viewer?rpc_port=${port}`;
}

export class ProcessManager {
  /**
   * Every child we know about, keyed by canonical trace path. Includes
   * recently-crashed children until they age out of CRASH_TTL_MS.
   */
  private readonly children = new Map<string, Child>();
  /**
   * Promises for in-flight ensureChild() calls, keyed by trace. A second
   * call for the same trace awaits the first instead of racing it — this is
   * what makes rapid double-clicks collapse into a single child.
   */
  private readonly inFlight = new Map<string, Promise<Child>>();
  private readonly allocator: PortAllocator;

  constructor(
    private readonly tpBinary: string,
    private readonly catalog: Catalog,
    private readonly bind: string,
    portBase: number,
    portCount: number,
    private readonly prewarmer: Prewarmer | undefined = undefined,
  ) {
    this.allocator = new PortAllocator(bind, portBase, portCount);
  }

  /**
   * Starts a trace_processor_shell server for `traceKey`, or returns quietly
   * if one is already live for that trace. Idempotent: rapid double-clicks
   * (or concurrent batch operations) collapse into a single child via the
   * inFlight map.
   */
  async ensureChild(traceKey: string): Promise<void> {
    await this.ensureChildInternal(traceKey);
  }

  private ensureChildInternal(traceKey: string): Promise<Child> {
    const trace = this.catalog.validate(traceKey);
    this.expireCrashed();

    const existing = this.children.get(trace);
    if (existing && existing.exit === null) return Promise.resolve(existing);

    const pending = this.inFlight.get(trace);
    if (pending !== undefined) return pending;

    if (existing) this.children.delete(trace); // crashed leftover — replace it

    const promise = this.spawnChild(trace).finally(() => {
      // Always clear the in-flight slot, success or failure — the next call
      // either finds the child in `children` or starts over.
      if (this.inFlight.get(trace) === promise) this.inFlight.delete(trace);
    });
    this.inFlight.set(trace, promise);
    return promise;
  }

  private async spawnChild(trace: string): Promise<Child> {
    const port = await this.allocator.allocate(this.livePorts());
    const proc = spawn(
      this.tpBinary,
      ['server', '--ip-address', this.bind, '--port', String(port), 'http', trace],
      {stdio: 'ignore', detached: true},
    );
    if (proc.pid === undefined) {
      throw new Error(`failed to spawn ${this.tpBinary}`);
    }

    const child: Child = {
      trace,
      port,
      pid: proc.pid,
      proc,
      startedMs: Date.now(),
      stopping: false,
      exit: null,
      prewarm: null,
      prewarmError: null,
    };
    proc.on('error', () => {
      // Spawn-time failure (e.g. the binary vanished): record it as a crash so
      // the failure is visible in the UI instead of being swallowed.
      if (child.exit === null) {
        child.exit = {code: null, signal: null, exitedMs: Date.now()};
      }
    });
    proc.on('exit', (code, signal) => {
      if (child.stopping) {
        // We asked for this exit; drop the child silently.
        if (this.children.get(trace) === child) this.children.delete(trace);
        return;
      }
      child.exit = {code, signal, exitedMs: Date.now()};
    });
    this.children.set(trace, child);
    return child;
  }

  /**
   * Ensures a child is live for `traceKey` and triggers a prewarm in the
   * background. Idempotent: re-invoking it while a prewarm is already
   * 'prewarming' or 'prewarmed' is a no-op. The promise resolves once the
   * prewarm has been *scheduled*, not once it has finished — callers poll
   * the snapshot to observe the transition to 'prewarmed' / 'prewarm-failed'.
   */
  async ensurePrewarm(traceKey: string): Promise<void> {
    if (this.prewarmer === undefined) {
      throw new Error('prewarm is not configured on this server');
    }
    // Use the child returned by ensureChildInternal directly — looking it up
    // through this.children afterwards opens a window where a concurrent
    // stop() could have removed it.
    const child = await this.ensureChildInternal(traceKey);
    if (child.exit !== null || child.stopping) return;
    if (child.prewarm === 'prewarming' || child.prewarm === 'prewarmed') {
      return; // already in flight or done
    }
    child.prewarm = 'prewarming';
    child.prewarmError = null;
    // Fire-and-forget; the child's prewarm field updates as the task runs and
    // any error surfaces through the snapshot.
    void this.runPrewarm(child);
  }

  /** Schedules a prewarm for every key; rejected keys are silently skipped. */
  async prewarmMany(keys: readonly string[]): Promise<number> {
    let scheduled = 0;
    for (const key of keys) {
      try {
        await this.ensurePrewarm(key);
        scheduled++;
      } catch {
        // Best-effort; one bad trace must not abort the rest.
      }
    }
    return scheduled;
  }

  /**
   * Stops a live child, or dismisses a crashed one. Returns true if a child
   * with that key was found.
   */
  stop(traceKey: string): boolean {
    const trace = this.canonicalise(traceKey);
    const child = trace !== null ? this.children.get(trace) : undefined;
    if (child === undefined) return false;
    this.children.delete(child.trace);
    if (child.exit === null) terminate(child);
    return true;
  }

  /** Stops every key in `keys`; returns how many were found. */
  stopMany(keys: readonly string[]): number {
    let stopped = 0;
    for (const key of keys) if (this.stop(key)) stopped++;
    return stopped;
  }

  /** Stops every known child (live and crashed). Used on shutdown. */
  stopAll(): number {
    const all = [...this.children.values()];
    this.children.clear();
    for (const child of all) if (child.exit === null) terminate(child);
    return all.length;
  }

  /** Point-in-time view of every child, for the API state endpoint. */
  async snapshot(): Promise<RunningChild[]> {
    this.expireCrashed();
    const children = [...this.children.values()];
    const liveness = await Promise.all(
      children.map((c) =>
        c.exit === null ? portIsOpen(this.bind, c.port) : Promise.resolve(false),
      ),
    );
    return children
      .map((child, i) => this.describe(child, liveness[i] ?? false))
      .sort(byRelThenStatus);
  }

  private describe(child: Child, portOpen: boolean): RunningChild {
    const status: RunningChild['status'] =
      child.exit !== null ? 'crashed' : portOpen ? 'live' : 'starting';
    let described: RunningChild = {
      key: child.trace,
      rel: this.catalog.rel(child.trace),
      name: path.basename(child.trace),
      port: child.port,
      pid: child.pid,
      startedMs: child.startedMs,
      status,
      rssBytes: child.exit === null ? processRss(child.pid) : 0,
      traceSize: fileSize(child.trace),
      perfettoUrl: perfettoUrl(child.port),
    };
    if (child.prewarm !== null) {
      described = {...described, prewarm: child.prewarm};
      if (child.prewarmError !== null) {
        described = {...described, prewarmError: child.prewarmError};
      }
    }
    if (child.exit !== null) {
      described = {...described, exit: child.exit};
    }
    return described;
  }

  /** Background task: wait for the port, hand off to the Prewarmer. */
  private async runPrewarm(child: Child): Promise<void> {
    if (this.prewarmer === undefined) return;
    try {
      const deadline = Date.now() + PREWARM_PORT_WAIT_MS;
      while (Date.now() < deadline) {
        if (child.exit !== null || child.stopping) return;
        if (await portIsOpen(this.bind, child.port)) break;
        await sleep(400);
      }
      if (child.exit !== null || child.stopping) return;
      if (!(await portIsOpen(this.bind, child.port))) {
        throw new Error('trace_processor did not come up in time');
      }
      await this.prewarmer.warm(child.port);
      if (child.exit === null && !child.stopping) {
        child.prewarm = 'prewarmed';
        child.prewarmError = null;
      }
    } catch (err) {
      if (child.exit !== null || child.stopping) return;
      child.prewarm = 'prewarm-failed';
      child.prewarmError = err instanceof Error ? err.message : String(err);
    }
  }

  private livePorts(): number[] {
    const ports: number[] = [];
    for (const child of this.children.values()) {
      if (child.exit === null) ports.push(child.port);
    }
    return ports;
  }

  private expireCrashed(): void {
    const now = Date.now();
    for (const [key, child] of this.children) {
      if (child.exit !== null && now - child.exit.exitedMs > CRASH_TTL_MS) {
        this.children.delete(key);
      }
    }
  }

  /** Resolves a UI-supplied key to a map key, tolerating an already-gone file. */
  private canonicalise(traceKey: string): string | null {
    if (this.children.has(traceKey)) return traceKey;
    try {
      return fs.realpathSync(traceKey);
    } catch {
      return null;
    }
  }
}

function terminate(child: Child): void {
  child.stopping = true;
  if (child.proc.exitCode !== null || child.proc.signalCode !== null) return;
  killGroup(child.pid, 'SIGTERM');
  const {pid} = child;
  setTimeout(() => killGroup(pid, 'SIGKILL'), KILL_GRACE_MS).unref();
}

/**
 * Signals the child's whole process group (children are spawned detached).
 *
 * Hardened against the "negative pid footgun": `process.kill(-1, sig)` would
 * fan out the signal to every process this server owns, taking the host
 * down with it. Even though the only caller passes a pid from `child.pid`
 * (set at spawn time, so always > 1 in practice), we refuse implausibly low
 * pids defensively. The check is one comparison; the upside is the host
 * survives a future refactor that accidentally passes 0 or 1.
 */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid < 100) {
    process.stderr.write(
      `process_manager: refusing to signal pgid=${pid} (` +
        `implausibly low — would risk killing system processes)\n`,
    );
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // Process group already gone — nothing to do.
  }
}

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/** Sort order for the running list: crashed children sink to the bottom. */
function byRelThenStatus(a: RunningChild, b: RunningChild): number {
  const rank = (s: RunningChild['status']): number => (s === 'crashed' ? 1 : 0);
  return rank(a.status) - rank(b.status) || a.rel.localeCompare(b.rel);
}
