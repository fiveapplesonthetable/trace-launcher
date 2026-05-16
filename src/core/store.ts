import m from 'mithril';

import type {
  AppState,
  CatalogColumn,
  CatalogFilter,
  RunningChild,
  TraceEntry,
} from '../../shared/types';
import {api, ApiError} from './api';

/** The visible runtime state of a catalog row. */
export type RowState = 'idle' | 'starting' | 'live' | 'crashed';

/** Per-trace error surfaced inline in the row (out-of-ports, validation, …). */
export interface RowError {
  readonly message: string;
  readonly code?: string;
}

/** Folds child status into the single row state the UI displays. */
export function rowStateFor(child: RunningChild | undefined): RowState {
  if (child === undefined) return 'idle';
  return child.status;
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

class AppStore {
  state: AppState | null = null;
  error: string | null = null;
  /** True until the first snapshot lands, so we can show a splash, not a flicker. */
  initialLoad = true;

  dir = '';
  query = '';
  filters: readonly CatalogFilter[] = [];
  /**
   * Sort is null until the user clicks a column header — null means
   * "let the server pick the natural order" (breadth-first by depth,
   * alphabetical by name). Once set, the server applies it verbatim.
   */
  sort: SortState | null = null;
  theme: Theme = readTheme();

  /** Trace keys with an in-flight start/stop request. */
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
    // First load always asks the server to bypass its dir cache —
    // covers the "I added a file then opened the page" case even if
    // the fs watcher missed the event.
    void this.refresh({force: true});
  }

  // --- catalog query -------------------------------------------------------

  /**
   * Re-fetches the application snapshot.
   *
   * The optional `force` flag asks the server to drop its directory
   * cache and re-scan from disk. Set it on user-initiated refresh
   * (the topbar button) and initial page load; leave it off for the
   * background poll loop so steady-state polling stays cheap.
   */
  async refresh(opts: {force?: boolean} = {}): Promise<void> {
    const seq = ++this.requestSeq;
    const query = {
      dir: this.dir,
      query: this.query,
      filters: this.filters,
      ...(this.sort !== null ? {sort: this.sort} : {}),
      ...(opts.force === true ? {refresh: true} : {}),
    };
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

  // --- view preferences ----------------------------------------------------

  /**
   * Cycles through "no explicit sort" → asc → desc → no explicit sort, so
   * the column header is a three-state toggle: a third click on the same
   * header drops back to the server's natural breadth-first order. Picking
   * a different column always starts from a sensible direction (descending
   * for size / modified, ascending for everything else).
   */
  setSort(column: string): void {
    const current = this.sort;
    if (current !== null && current.column === column) {
      if (current.direction === 'asc') {
        this.sort = {column, direction: 'desc'};
      } else {
        this.sort = null;
      }
    } else {
      const descFirst = column === 'size' || column === 'modified';
      this.sort = {column, direction: descFirst ? 'desc' : 'asc'};
    }
    void this.refresh();
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

  startVisible(): Promise<void> {
    const keys = this.visibleTraceKeys();
    return this.withPending(keys, () => api.startBatch(keys));
  }

  stopVisible(): Promise<void> {
    const keys = this.visibleTraceKeys();
    return this.withPending(keys, () => api.stopBatch(keys));
  }

  /** How many *visible* rows are currently live — i.e. have an openable
   * ui.perfetto.dev deep link. Used to disable "Open all shown" when
   * there is nothing to open. */
  visibleLiveCount(): number {
    const visible = new Set(this.visibleTraceKeys());
    let n = 0;
    for (const child of this.state?.running ?? []) {
      if (visible.has(child.key) && child.status === 'live') n++;
    }
    return n;
  }

  /**
   * Open every visible *live* trace in its own new browser tab — one
   * ui.perfetto.dev deep link per row. Idle / starting / crashed rows
   * are silently skipped: they have no bound port, so they have no URL
   * to open. Returns the number of tabs opened so the caller can surface
   * "nothing to open" without a popup-block fight.
   *
   * Browsers gate "open many tabs at once" on the call being part of a
   * direct user gesture. The canonical idiom that survives the strictest
   * popup blockers is a synthetic click on a temporary <a target="_blank">
   * — more permissive than window.open() in a loop, since the browser
   * treats it as link navigation rather than scripted popping. The anchor
   * is hidden, attached, clicked, and removed within the same tick so it
   * is never observable in the DOM.
   */
  openVisible(): number {
    const visible = new Set(this.visibleTraceKeys());
    const urls: string[] = [];
    for (const child of this.state?.running ?? []) {
      if (!visible.has(child.key)) continue;
      if (child.status !== 'live') continue;
      urls.push(child.perfettoUrl);
    }
    for (const url of urls) {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    return urls.length;
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

  /**
   * Catalog traces after status filtering. Sort order is owned server-side:
   * the rows come back from `/api/state` already in the requested order.
   * The status filter stays here because it depends on the per-trace
   * running child state — a join the server can't do without us echoing
   * back its own `running` array.
   */
  sortedTraces(): readonly TraceEntry[] {
    return this.clientFilteredTraces();
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
      (this.state?.running ?? []).some((c) => c.status === 'starting');
    const delay = settling ? ACTIVE_POLL_MS : IDLE_POLL_MS;
    this.pollTimer = window.setTimeout(() => void this.refresh(), delay);
  }
}

export const store = new AppStore();
