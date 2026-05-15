import m from 'mithril';

import type {
  AppState,
  CatalogColumn,
  CatalogFilter,
  MetadataValue,
  RunningChild,
  TraceEntry,
} from '../../shared/types';
import {api, ApiError} from './api';

/** The visible runtime state of a catalog row, after rolling in prewarm. */
export type RowState =
  | 'idle'
  | 'starting'
  | 'live'
  | 'prewarming'
  | 'prewarmed'
  | 'crashed';

/** Per-trace error surfaced inline in the row (out-of-ports, validation, …). */
export interface RowError {
  readonly message: string;
  readonly code?: string;
}

/** Folds child status + prewarm into the single row state the UI displays. */
export function rowStateFor(child: RunningChild | undefined): RowState {
  if (child === undefined) return 'idle';
  if (child.status === 'starting') return 'starting';
  if (child.status === 'crashed') return 'crashed';
  if (child.prewarm === 'prewarming') return 'prewarming';
  if (child.prewarm === 'prewarmed') return 'prewarmed';
  return 'live';
}

// The single source of truth for the SPA. Components read its public fields and
// call its action methods; it owns the API client, the poll loop, the catalog
// query (dir / search / filters), and all transient "pending" UI state.
//
// Mithril auto-redraws after DOM event handlers, so action methods only call
// m.redraw() explicitly for state changes that happen off the event loop
// (poll results, debounced search, resolved promises).

export type Theme = 'dark' | 'light';
export type SortDirection = 'asc' | 'desc';

export interface SortState {
  readonly column: string;
  readonly direction: SortDirection;
}

const THEME_KEY = 'trace-launcher.theme';
const COLUMNS_KEY = 'trace-launcher.columns';
/** Poll cadence once everything has settled. */
const IDLE_POLL_MS = 3000;
/** Faster cadence while a child is still coming up, so 'live' lands quickly. */
const ACTIVE_POLL_MS = 600;
/** Debounce applied to the search box before it hits the network. */
const SEARCH_DEBOUNCE_MS = 160;

function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function readVisibleColumns(): Set<string> | null {
  try {
    const raw = localStorage.getItem(COLUMNS_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
      return new Set(parsed);
    }
  } catch {
    // Corrupt preference — fall back to the per-column defaults.
  }
  return null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Orders two metadata cells, sorting empty values last. */
function compareValues(
  a: MetadataValue | undefined,
  b: MetadataValue | undefined,
): number {
  const aEmpty = a === null || a === undefined;
  const bEmpty = b === null || b === undefined;
  if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

class AppStore {
  state: AppState | null = null;
  error: string | null = null;
  /** True until the first snapshot lands, so we can show a splash, not a flicker. */
  initialLoad = true;

  dir = '';
  query = '';
  filters: readonly CatalogFilter[] = [];
  sort: SortState = {column: 'name', direction: 'asc'};
  theme: Theme = readTheme();

  /** Trace keys with an in-flight start/stop/prewarm request. */
  readonly pending = new Set<string>();
  /** Per-trace inline errors (out-of-ports, validation, …); cleared on retry. */
  readonly errors = new Map<string, RowError>();

  /** Visible column ids; null means "use each column's default". */
  private visibleColumns: Set<string> | null = readVisibleColumns();
  private pollTimer: number | undefined;
  private searchTimer: number | undefined;
  /** Monotonic id so a slow stale response can't overwrite a newer one. */
  private requestSeq = 0;

  start(): void {
    document.documentElement.dataset.theme = this.theme;
    void this.refresh();
  }

  // --- catalog query -------------------------------------------------------

  async refresh(): Promise<void> {
    const seq = ++this.requestSeq;
    const query = {dir: this.dir, query: this.query, filters: this.filters};
    try {
      const next = await api.getState(query);
      if (seq !== this.requestSeq) return; // superseded by a newer request
      this.state = next;
      this.error = null;
    } catch (err) {
      if (seq !== this.requestSeq) return;
      this.error = messageOf(err);
    } finally {
      if (seq === this.requestSeq) {
        this.initialLoad = false;
        this.schedulePoll();
        m.redraw();
      }
    }
  }

  navigateTo(dir: string): void {
    this.dir = dir;
    this.query = '';
    this.filters = [];
    window.clearTimeout(this.searchTimer);
    void this.refresh();
  }

  /** Updates the search term and refreshes after a short debounce. */
  setQuery(query: string): void {
    this.query = query;
    window.clearTimeout(this.searchTimer);
    this.searchTimer = window.setTimeout(() => void this.refresh(), SEARCH_DEBOUNCE_MS);
  }

  addFilter(filter: CatalogFilter): void {
    this.filters = [...this.filters, filter];
    void this.refresh();
  }

  removeFilter(index: number): void {
    this.filters = this.filters.filter((_, i) => i !== index);
    void this.refresh();
  }

  clearFilters(): void {
    if (this.filters.length === 0) return;
    this.filters = [];
    void this.refresh();
  }

  // --- view preferences (no network) ---------------------------------------

  /** Sorts by `column`, toggling direction when it is already the sort key. */
  setSort(column: string): void {
    if (this.sort.column === column) {
      const direction = this.sort.direction === 'asc' ? 'desc' : 'asc';
      this.sort = {column, direction};
    } else {
      const descFirst = column === 'size' || column === 'modified';
      this.sort = {column, direction: descFirst ? 'desc' : 'asc'};
    }
  }

  toggleColumn(id: string): void {
    const next = this.effectiveColumns();
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.visibleColumns = next;
    try {
      localStorage.setItem(COLUMNS_KEY, JSON.stringify([...next]));
    } catch {
      // Persisting preferences is best-effort.
    }
  }

  toggleTheme(): void {
    this.theme = this.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = this.theme;
    try {
      localStorage.setItem(THEME_KEY, this.theme);
    } catch {
      // Persisting preferences is best-effort.
    }
  }

  // --- process actions -----------------------------------------------------

  open(key: string): Promise<void> {
    return this.withPending([key], () => api.open(key));
  }

  stop(key: string): Promise<void> {
    return this.withPending([key], () => api.stop(key));
  }

  prewarm(key: string): Promise<void> {
    return this.withPending([key], () => api.prewarm(key));
  }

  startVisible(): Promise<void> {
    const keys = this.visibleTraceKeys();
    return this.withPending(keys, () => api.startBatch(keys));
  }

  stopVisible(): Promise<void> {
    const keys = this.visibleTraceKeys();
    return this.withPending(keys, () => api.stopBatch(keys));
  }

  prewarmVisible(): Promise<void> {
    const keys = this.visibleTraceKeys();
    return this.withPending(keys, () => api.prewarmBatch(keys));
  }

  stopAll(): Promise<void> {
    const keys = (this.state?.running ?? []).map((c) => c.key);
    return this.withPending(keys, () => api.stopAll());
  }

  /** Per-row inline error (or undefined). */
  errorFor(key: string): RowError | undefined {
    return this.errors.get(key);
  }

  clearError(key: string): void {
    if (this.errors.delete(key)) m.redraw();
  }

  suggest(column: string, prefix: string): Promise<readonly string[]> {
    return api.suggest(column, prefix);
  }

  // --- selectors -----------------------------------------------------------

  runningFor(key: string): RunningChild | undefined {
    return this.state?.running.find((c) => c.key === key);
  }

  isPending(key: string): boolean {
    return this.pending.has(key);
  }

  /** Columns the server offers, in display order. */
  availableColumns(): readonly CatalogColumn[] {
    return this.state?.config.columns ?? [];
  }

  columnIsVisible(id: string): boolean {
    return this.effectiveColumns().has(id);
  }

  /** Catalog traces after status filtering, in the user's sort order. */
  sortedTraces(): readonly TraceEntry[] {
    const traces = [...this.clientFilteredTraces()];
    const {column, direction} = this.sort;
    const sign = direction === 'asc' ? 1 : -1;
    traces.sort((a, b) => sign * this.compare(column, a, b));
    return traces;
  }

  /**
   * Catalog traces with every active client-side filter applied. Today the
   * only client-side filter is `status` (a synthetic column whose values are
   * the live RunningChild status); other filters are evaluated server-side.
   */
  private clientFilteredTraces(): readonly TraceEntry[] {
    const all = this.state?.catalog.traces ?? [];
    const statusFilters = this.filters.filter((f) => f.column === 'status');
    if (statusFilters.length === 0) return all;
    return all.filter((trace) => {
      const state = rowStateFor(this.runningFor(trace.key));
      return statusFilters.every((filter) => {
        const target = filter.value.trim().toLowerCase();
        if (filter.op === 'equals') return state === target;
        return state.includes(target);
      });
    });
  }

  // --- internals -----------------------------------------------------------

  private compare(column: string, a: TraceEntry, b: TraceEntry): number {
    switch (column) {
      case 'name':
        return a.name.localeCompare(b.name);
      case 'rel':
        return a.rel.localeCompare(b.rel);
      case 'size':
        return a.size - b.size;
      case 'modified':
        return a.mtimeMs - b.mtimeMs;
      default: {
        if (!column.startsWith('meta:')) return 0;
        const field = column.slice('meta:'.length);
        return compareValues(a.metadata?.[field], b.metadata?.[field]);
      }
    }
  }

  private effectiveColumns(): Set<string> {
    if (this.visibleColumns !== null) return new Set(this.visibleColumns);
    const columns = this.state?.config.columns ?? [];
    return new Set(
      columns.filter((c) => c.defaultVisible).map((c) => c.id),
    );
  }

  private visibleTraceKeys(): readonly string[] {
    return this.clientFilteredTraces().map((t) => t.key);
  }

  private async withPending(
    keys: readonly string[],
    action: () => Promise<void>,
  ): Promise<void> {
    for (const key of keys) {
      this.pending.add(key);
      // Retrying clears the previous inline error before we know the outcome.
      this.errors.delete(key);
    }
    m.redraw();
    try {
      await action();
    } catch (err) {
      const message = messageOf(err);
      const code = err instanceof ApiError ? err.code : undefined;
      const [singleKey] = keys;
      if (keys.length === 1 && singleKey !== undefined) {
        this.errors.set(
          singleKey,
          code !== undefined ? {message, code} : {message},
        );
      } else {
        this.error = message;
      }
    } finally {
      for (const key of keys) this.pending.delete(key);
      await this.refresh();
    }
  }

  /** (Re)arms the poll timer, picking its cadence from current activity. */
  private schedulePoll(): void {
    window.clearTimeout(this.pollTimer);
    const settling =
      this.pending.size > 0 ||
      (this.state?.running ?? []).some(
        (c) => c.status === 'starting' || c.prewarm === 'prewarming',
      );
    const delay = settling ? ACTIVE_POLL_MS : IDLE_POLL_MS;
    this.pollTimer = window.setTimeout(() => void this.refresh(), delay);
  }
}

export const store = new AppStore();
