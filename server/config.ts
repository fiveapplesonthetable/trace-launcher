import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseArgs} from 'node:util';

import {expandUser} from './catalog';

// Command-line parsing and validation. Everything that can be wrong about the
// invocation is caught here and turned into a single, readable UsageError, so
// the rest of the server can assume its inputs are sane.

export interface LaunchOptions {
  readonly tpBinary: string;
  readonly tracesDir: string;
  /** Explicit trace allow-list; empty means "browse the whole directory". */
  readonly traces: readonly string[];
  readonly bind: string;
  readonly port: number;
  readonly tpPortBase: number;
  readonly tpPortCount: number;
  /**
   * Workers in flight for batch operations (Start all shown / Prewarm all
   * shown). Defaults to `Math.min(8, max(2, nproc))`; override via
   * `--batch-concurrency` for tightly-resourced or beefy boxes.
   */
  readonly batchConcurrency: number;
  readonly maxResults: number;
  readonly recursiveSearch: boolean;
  /** Optional SQLite metadata DB; null disables the whole metadata layer. */
  readonly metadataDb: string | null;
  readonly metadataTable: string | null;
  readonly metadataKeyColumn: string | null;
}

/** Thrown for bad CLI input; the caller prints it and exits non-zero. */
export class UsageError extends Error {}

/** Thrown when `--help` is passed; the caller prints USAGE and exits zero. */
export class HelpRequested extends Error {}

export const USAGE = `trace-launcher — a fast web UI for launching trace_processor_shell servers

Usage:
  npm start -- --tp-binary <path> --traces-dir <dir> [options]

Required:
  --tp-binary <path>     trace_processor_shell executable
  --traces-dir <dir>     directory of trace files to browse

Options:
  --trace <path>             expose only this trace; repeatable. Relative paths
                             resolve under --traces-dir, disabling browsing.
  --bind <addr>              address for the UI + backend servers (default 127.0.0.1)
  --port <n>                 port for the UI + API (default 9002)
  --tp-port-base <n>         first backend trace_processor port (default 19000)
  --tp-port-count <n>        size of the backend port range (default 4096)
  --batch-concurrency <n>    workers for "Start all shown" / "Prewarm all shown"
                             (default: clamp(nproc, 2, 8))
  --max-results <n>          max traces shown per page; 0 = unlimited (default 5000)
  --recursive-search         search recursively under --traces-dir (default)
  --no-recursive-search      scope search to the current directory only

Metadata (optional — joins a SQLite table to the trace list):
  --metadata-db <path>       SQLite database with a row of metadata per trace
  --metadata-table <name>    table inside --metadata-db to read
  --metadata-key-column <c>  column holding the trace path/name to join on
                             (auto-detected from common names if omitted)

  --help                     show this message
`;

function toInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new UsageError(`${flag} must be an integer`);
  return n;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function parseLaunchOptions(argv: readonly string[]): LaunchOptions {
  let values: ReturnType<typeof parseArgs>['values'];
  try {
    ({values} = parseArgs({
      args: [...argv],
      allowPositionals: false,
      options: {
        'tp-binary': {type: 'string'},
        'traces-dir': {type: 'string'},
        trace: {type: 'string', multiple: true},
        bind: {type: 'string', default: '127.0.0.1'},
        port: {type: 'string', default: '9002'},
        'tp-port-base': {type: 'string', default: '19000'},
        'tp-port-count': {type: 'string', default: '4096'},
        'batch-concurrency': {type: 'string'},
        'max-results': {type: 'string', default: '5000'},
        'recursive-search': {type: 'boolean', default: true},
        'no-recursive-search': {type: 'boolean', default: false},
        'metadata-db': {type: 'string'},
        'metadata-table': {type: 'string'},
        'metadata-key-column': {type: 'string'},
        help: {type: 'boolean', default: false},
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }

  if (values.help === true) throw new HelpRequested();

  const rawTpBinary = values['tp-binary'];
  const rawTracesDir = values['traces-dir'];
  if (typeof rawTpBinary !== 'string') {
    throw new UsageError('--tp-binary is required');
  }
  if (typeof rawTracesDir !== 'string') {
    throw new UsageError('--traces-dir is required');
  }

  const tpBinary = path.resolve(expandUser(rawTpBinary));
  const tracesDir = path.resolve(expandUser(rawTracesDir));
  try {
    fs.accessSync(tpBinary, fs.constants.X_OK);
  } catch {
    throw new UsageError(`--tp-binary is not an executable file: ${tpBinary}`);
  }
  if (!isDirectory(tracesDir)) {
    throw new UsageError(`--traces-dir is not a directory: ${tracesDir}`);
  }

  const port = toInt(asString(values.port, '9002'), '--port');
  const tpPortBase = toInt(asString(values['tp-port-base'], '19000'), '--tp-port-base');
  const tpPortCount = toInt(asString(values['tp-port-count'], '4096'), '--tp-port-count');
  const maxResults = toInt(asString(values['max-results'], '5000'), '--max-results');

  // Default the batch worker count to the host's CPU count, clamped to a
  // sensible range. The cap (8) reflects that even on big boxes the
  // prewarmer's headless Chrome is the bottleneck — more workers than
  // ~CPU/2 thrash it. Min 2 keeps batches parallel even on tiny VMs.
  const cpus = Math.max(1, os.cpus().length);
  const defaultBatchConcurrency = Math.max(2, Math.min(8, cpus));
  const batchConcurrencyRaw = values['batch-concurrency'];
  const batchConcurrency =
    typeof batchConcurrencyRaw === 'string'
      ? toInt(batchConcurrencyRaw, '--batch-concurrency')
      : defaultBatchConcurrency;

  if (port < 1 || port > 65535) throw new UsageError('--port is out of range');
  if (tpPortBase < 1 || tpPortBase > 65535) {
    throw new UsageError('--tp-port-base is out of range');
  }
  if (tpPortCount < 1 || tpPortBase + tpPortCount - 1 > 65535) {
    throw new UsageError('--tp-port-count makes an invalid port range');
  }
  if (batchConcurrency < 1 || batchConcurrency > 64) {
    throw new UsageError('--batch-concurrency must be between 1 and 64');
  }
  if (maxResults < 0) throw new UsageError('--max-results must be >= 0');

  const rawMetadataDb = values['metadata-db'];
  const rawMetadataTable = values['metadata-table'];
  const rawMetadataKeyColumn = values['metadata-key-column'];
  let metadataDb: string | null = null;
  let metadataTable: string | null = null;
  if (typeof rawMetadataDb === 'string') {
    if (typeof rawMetadataTable !== 'string') {
      throw new UsageError('--metadata-table is required with --metadata-db');
    }
    metadataDb = path.resolve(expandUser(rawMetadataDb));
    metadataTable = rawMetadataTable;
    try {
      fs.accessSync(metadataDb, fs.constants.R_OK);
    } catch {
      throw new UsageError(`--metadata-db is not a readable file: ${metadataDb}`);
    }
  } else if (typeof rawMetadataTable === 'string') {
    throw new UsageError('--metadata-table requires --metadata-db');
  }

  return {
    tpBinary,
    tracesDir,
    traces: asStringArray(values.trace),
    bind: asString(values.bind, '127.0.0.1'),
    port,
    tpPortBase,
    tpPortCount,
    batchConcurrency,
    maxResults,
    // Recursive search defaults on; an explicit --no-recursive-search wins.
    recursiveSearch: values['no-recursive-search'] !== true,
    metadataDb,
    metadataTable,
    metadataKeyColumn:
      typeof rawMetadataKeyColumn === 'string' ? rawMetadataKeyColumn : null,
  };
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
