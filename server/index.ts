import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import express from 'express';

import type {ServerConfig} from '../shared/types';
import {createApiRouter} from './api';
import {Catalog} from './catalog';
import {
  HelpRequested,
  parseLaunchOptions,
  UsageError,
  USAGE,
  type LaunchOptions,
} from './config';
import {MetadataError, MetadataStore} from './metadata';
import {Prewarmer} from './prewarmer';
import {ProcessManager} from './process_manager';

// Entry point: parse the CLI, wire the catalog + metadata + process manager
// into the Express app, serve the built SPA (if present) alongside the API,
// and reap every child process cleanly on shutdown.

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

/** Prints a startup error and exits non-zero — never returns. */
function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(2);
}

/** Opens the metadata DB if configured, or returns undefined. */
function openMetadata(options: LaunchOptions): MetadataStore | undefined {
  if (options.metadataDb === null || options.metadataTable === null) {
    return undefined;
  }
  try {
    return new MetadataStore(
      options.metadataDb,
      options.metadataTable,
      options.metadataKeyColumn ?? undefined,
    );
  } catch (err) {
    if (err instanceof MetadataError) fail(err.message);
    throw err;
  }
}

function main(argv: readonly string[]): void {
  let options: LaunchOptions;
  try {
    options = parseLaunchOptions(argv);
  } catch (err) {
    if (err instanceof HelpRequested) {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    if (err instanceof UsageError) {
      process.stderr.write(`error: ${err.message}\n\n${USAGE}`);
      process.exit(2);
    }
    throw err;
  }

  const metadata = openMetadata(options);

  let catalog: Catalog;
  try {
    catalog = new Catalog(
      options.tracesDir,
      options.traces,
      options.maxResults,
      options.recursiveSearch,
      metadata,
    );
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  const prewarmer = new Prewarmer();
  const processes = new ProcessManager(
    options.tpBinary,
    catalog,
    options.bind,
    options.tpPortBase,
    options.tpPortCount,
    prewarmer,
    options.batchConcurrency,
  );

  const config: ServerConfig = {
    tpBinary: options.tpBinary,
    tracesDir: catalog.root,
    bind: options.bind,
    recursiveSearch: options.recursiveSearch,
    tpPortRange: [
      options.tpPortBase,
      options.tpPortBase + options.tpPortCount - 1,
    ],
    columns: catalog.columns(),
    metadataEnabled: metadata !== undefined,
  };

  const app = express();
  app.use('/api', createApiRouter({catalog, processes, metadata, config}));

  const hasDist = fs.existsSync(path.join(DIST_DIR, 'index.html'));
  if (hasDist) {
    app.use(express.static(DIST_DIR));
    // SPA shell for any non-API GET that didn't match a static asset.
    app.get('*', (_req, res) => {
      res.sendFile(path.join(DIST_DIR, 'index.html'));
    });
  }

  const server = app.listen(options.port, options.bind, () => {
    log(`trace-launcher  ->  http://${options.bind}:${options.port}/`);
    log(`traces dir          ${catalog.root}`);
    log(`tp binary           ${options.tpBinary}`);
    log(
      `backend ports       ${options.bind}:` +
        `${config.tpPortRange[0]}-${config.tpPortRange[1]}`,
    );
    if (options.traces.length > 0) {
      log(`selected traces     ${options.traces.length}`);
    }
    if (metadata !== undefined) {
      log(`metadata            ${options.metadataDb} (${options.metadataTable})`);
    }
    if (!hasDist) {
      log('note: dist/ not built — run `npm run build`, or use `npm run dev`.');
    }
  });

  // process_manager schedules SIGKILL `KILL_GRACE_MS` (5 s) after SIGTERM for
  // each child. The shutdown backstop must outlive that, otherwise we exit
  // before the kernel reaps the trace_processors and they become orphans.
  const SHUTDOWN_BACKSTOP_MS = 8_000;
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    const stopped = processes.stopAll();
    metadata?.close();
    // Close the headless browser. Awaiting is best-effort here — if it hangs,
    // the backstop below still exits the process.
    void prewarmer.close();
    log(`\n${signal} — stopped ${stopped} trace processor(s), exiting.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), SHUTDOWN_BACKSTOP_MS).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main(process.argv.slice(2));
