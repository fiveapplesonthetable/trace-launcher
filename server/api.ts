import express from 'express';

import type {
  CatalogFilter,
  FilterOp,
  ServerConfig,
  StateRequest,
} from '../shared/types';
import {Catalog, CatalogError} from './catalog';
import {MetadataError, type MetadataStore} from './metadata';
import {OutOfPortsError} from './ports';
import type {ProcessManager} from './process_manager';
import {systemStats} from './system';

// The HTTP API: JSON in, JSON out. It is a thin layer that translates requests
// into Catalog / ProcessManager / MetadataStore calls — all the real logic
// lives in those.

export interface ApiDeps {
  readonly catalog: Catalog;
  readonly processes: ProcessManager;
  readonly metadata: MetadataStore | undefined;
  readonly config: ServerConfig;
}

const FILTER_OPS: readonly FilterOp[] = [
  'contains',
  'equals',
  'gt',
  'gte',
  'lt',
  'lte',
];

/** Builds the Express router mounted at /api. */
export function createApiRouter(deps: ApiDeps) {
  const {catalog, processes, metadata, config} = deps;
  const router = express.Router();
  router.use(express.json({limit: '256kb'}));

  // Full application snapshot: catalog page + running children + host stats.
  // The UI polls this; the body selects which catalog page to return.
  router.post('/state', async (req, res) => {
    try {
      const {dir, query, filters, sort} = readStateRequest(req.body);
      res.json({
        config,
        catalog: catalog.list(query, dir, filters, sort),
        running: await processes.snapshot(),
        system: systemStats(catalog.root),
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  // Autocomplete: distinct values of a metadata column for the filter editor.
  router.get('/metadata/suggest', (req, res) => {
    if (metadata === undefined) {
      res.json({values: []});
      return;
    }
    const column = typeof req.query.column === 'string' ? req.query.column : '';
    const prefix = typeof req.query.prefix === 'string' ? req.query.prefix : '';
    if (column === '') {
      res.status(400).json({error: 'missing "column" query parameter'});
      return;
    }
    try {
      res.json({values: metadata.suggest(column, prefix)});
    } catch (err) {
      sendError(res, err);
    }
  });

  // Start a trace processor for one trace. Idempotent.
  router.post('/open', async (req, res) => {
    const trace = readTrace(req.body);
    if (trace === null) {
      res.status(400).json({error: 'request body must be {"trace": "<path>"}'});
      return;
    }
    try {
      await processes.ensureChild(trace);
      res.json({ok: true});
    } catch (err) {
      sendError(res, err, {ok: false});
    }
  });

  // Stop a live child, or dismiss a crashed one.
  router.post('/stop', (req, res) => {
    const trace = readTrace(req.body);
    if (trace === null) {
      res.status(400).json({error: 'request body must be {"trace": "<path>"}'});
      return;
    }
    res.json({ok: processes.stop(trace)});
  });

  // Best-effort: start every trace in the list in parallel, ignoring
  // individual failures. Concurrency is bounded server-side to the
  // configured worker count (defaults to nproc, capped at 8).
  router.post('/start-batch', async (req, res) => {
    const started = await processes.startMany(readTraces(req.body));
    res.json({started});
  });

  router.post('/stop-batch', (req, res) => {
    res.json({stopped: processes.stopMany(readTraces(req.body))});
  });

  router.post('/stop-all', (_req, res) => {
    res.json({stopped: processes.stopAll()});
  });

  router.use((_req, res) => {
    res.status(404).json({error: 'unknown API endpoint'});
  });

  return router;
}

function sendError(
  res: express.Response,
  err: unknown,
  extra: Record<string, unknown> = {},
): void {
  const message = err instanceof Error ? err.message : String(err);
  let status = 500;
  let code: string | undefined;
  if (err instanceof CatalogError || err instanceof MetadataError) {
    status = 400;
  } else if (err instanceof OutOfPortsError) {
    status = 409;
    code = err.code;
  }
  res.status(status).json({...extra, error: message, ...(code ? {code} : {})});
}

/** Parses and sanitises a POST /state request body. */
function readStateRequest(body: unknown): StateRequest {
  const obj =
    body !== null && typeof body === 'object'
      ? (body as Record<string, unknown>)
      : {};
  return {
    dir: typeof obj.dir === 'string' ? obj.dir : '',
    query: typeof obj.query === 'string' ? obj.query : '',
    filters: Array.isArray(obj.filters) ? obj.filters.filter(isFilter) : [],
    sort: isSort(obj.sort) ? obj.sort : undefined,
  };
}

function isSort(value: unknown): value is StateRequest['sort'] {
  if (value === null || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.column === 'string' &&
    s.column.length > 0 &&
    (s.direction === 'asc' || s.direction === 'desc')
  );
}

function isFilter(value: unknown): value is CatalogFilter {
  if (value === null || typeof value !== 'object') return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.column === 'string' &&
    typeof f.value === 'string' &&
    typeof f.op === 'string' &&
    (FILTER_OPS as readonly string[]).includes(f.op)
  );
}

/** Extracts a non-empty `trace` string from a request body, or null. */
function readTrace(body: unknown): string | null {
  if (body !== null && typeof body === 'object' && 'trace' in body) {
    const {trace} = body as {trace: unknown};
    if (typeof trace === 'string' && trace.length > 0) return trace;
  }
  return null;
}

/** Extracts the `traces` string array from a request body, or []. */
function readTraces(body: unknown): readonly string[] {
  if (body !== null && typeof body === 'object' && 'traces' in body) {
    const {traces} = body as {traces: unknown};
    if (Array.isArray(traces)) {
      return traces.filter((t): t is string => typeof t === 'string');
    }
  }
  return [];
}
