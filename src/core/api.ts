import type {
  AppState,
  CatalogFilter,
  SuggestResponse,
} from '../../shared/types';

// Typed client for the trace-launcher HTTP API. Every method either resolves
// with the parsed payload or rejects with an Error carrying the server's
// message — callers never deal with a raw Response or status code.

const BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, init);
  } catch {
    throw new Error('cannot reach the trace-launcher server');
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(extractError(payload, response.status));
  }
  return payload as T;
}

function extractError(payload: unknown, status: number): string {
  if (
    payload !== null &&
    typeof payload === 'object' &&
    'error' in payload &&
    typeof (payload as {error: unknown}).error === 'string'
  ) {
    return (payload as {error: string}).error;
  }
  return `request failed (${status})`;
}

function postJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  });
}

/** Selects which catalog page POST /api/state should return. */
export interface StateQuery {
  readonly dir: string;
  readonly query: string;
  readonly filters: readonly CatalogFilter[];
}

function discard(): void {}

export const api = {
  getState(query: StateQuery): Promise<AppState> {
    return postJson<AppState>('/state', query);
  },
  open(trace: string): Promise<void> {
    return postJson<unknown>('/open', {trace}).then(discard);
  },
  stop(trace: string): Promise<void> {
    return postJson<unknown>('/stop', {trace}).then(discard);
  },
  startBatch(traces: readonly string[]): Promise<void> {
    return postJson<unknown>('/start-batch', {traces}).then(discard);
  },
  stopBatch(traces: readonly string[]): Promise<void> {
    return postJson<unknown>('/stop-batch', {traces}).then(discard);
  },
  stopAll(): Promise<void> {
    return postJson<unknown>('/stop-all', {}).then(discard);
  },
  suggest(column: string, prefix: string): Promise<readonly string[]> {
    const params = new URLSearchParams({column, prefix});
    return request<SuggestResponse>(
      `/metadata/suggest?${params.toString()}`,
    ).then((r) => r.values);
  },
};
