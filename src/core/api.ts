import type {
  AppState,
  CatalogFilter,
  SuggestResponse,
} from '../../shared/types';

// Typed client for the trace-launcher HTTP API. Every method either resolves
// with the parsed payload or rejects with an Error carrying the server's
// message — callers never deal with a raw Response or status code.

const BASE = '/api';

/** Error thrown by api methods; carries the server's stable `code`, if any. */
export class ApiError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, init);
  } catch {
    throw new ApiError('cannot reach the trace-launcher server');
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const {message, code} = extractError(payload, response.status);
    throw new ApiError(message, code);
  }
  return payload as T;
}

function extractError(
  payload: unknown,
  status: number,
): {message: string; code?: string} {
  if (payload !== null && typeof payload === 'object') {
    const obj = payload as {error?: unknown; code?: unknown};
    if (typeof obj.error === 'string') {
      return {
        message: obj.error,
        ...(typeof obj.code === 'string' ? {code: obj.code} : {}),
      };
    }
  }
  return {message: `request failed (${status})`};
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
  prewarm(trace: string): Promise<void> {
    return postJson<unknown>('/prewarm', {trace}).then(discard);
  },
  prewarmBatch(traces: readonly string[]): Promise<void> {
    return postJson<unknown>('/prewarm-batch', {traces}).then(discard);
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
