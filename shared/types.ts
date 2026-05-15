// Wire protocol shared by the Node API server (server/) and the Mithril SPA
// (src/). This is the single source of truth for the shape of every request
// and response; both sides import it so the contract cannot drift.
//
// Conventions:
//  - A trace's absolute, real path is its stable identity ("key"). The client
//    never constructs keys; it only echoes back keys the server handed out.
//  - All sizes are bytes, all timestamps are epoch milliseconds.

// --- trace processors --------------------------------------------------------

/** Lifecycle of a spawned trace_processor_shell child. */
export type ChildStatus = 'starting' | 'live' | 'crashed';

/**
 * Lifecycle of the per-child prewarm task: a headless browser that loads
 * ui.perfetto.dev against the child's RPC port so the trace_processor caches
 * the UI's initial queries.
 */
export type PrewarmStatus = 'prewarming' | 'prewarmed' | 'prewarm-failed';

/** How a child process ended (only present once it has exited). */
export interface ChildExit {
  /** Process exit code, or null if it was terminated by a signal. */
  readonly code: number | null;
  /** Terminating signal name, or null if it exited normally. */
  readonly signal: string | null;
  readonly exitedMs: number;
}

/** A trace_processor_shell server launched by this tool. */
export interface RunningChild {
  /** Absolute real path of the trace; stable identity key. */
  readonly key: string;
  /** Path relative to the traces root (or absolute, if outside it). */
  readonly rel: string;
  readonly name: string;
  readonly port: number;
  readonly pid: number;
  readonly startedMs: number;
  readonly status: ChildStatus;
  /** Resident set size of the child, in bytes. 0 once it has exited. */
  readonly rssBytes: number;
  readonly traceSize: number;
  /** Deep link that opens this child's RPC port in ui.perfetto.dev. */
  readonly perfettoUrl: string;
  /** Populated only when status is 'crashed'. */
  readonly exit?: ChildExit;
  /** Present only when prewarm has been triggered for this child. */
  readonly prewarm?: PrewarmStatus;
  /** Populated when prewarm is 'prewarm-failed'. */
  readonly prewarmError?: string;
}

// --- catalog -----------------------------------------------------------------

/** A single metadata cell value, as SQLite hands it back. */
export type MetadataValue = string | number | null;

/** One row of trace metadata, keyed by column name. */
export type MetadataRow = Readonly<Record<string, MetadataValue>>;

/** Whether a column holds text or numbers — drives sorting and filter ops. */
export type ColumnKind = 'text' | 'number';

/**
 * A column the UI can show, sort, or filter on. Built-in "file" columns
 * (path/size/modified) plus one per column of the optional metadata table.
 */
export interface CatalogColumn {
  /** Stable id: 'rel' | 'size' | 'modified' | `meta:<column>`. */
  readonly id: string;
  readonly label: string;
  readonly kind: ColumnKind;
  readonly source: 'file' | 'metadata';
  /** True when this column can be used in a structured filter. */
  readonly filterable: boolean;
  /** True for columns shown by default before the user customises. */
  readonly defaultVisible: boolean;
}

/** Comparison operators available to filters. */
export type FilterOp = 'contains' | 'equals' | 'gt' | 'gte' | 'lt' | 'lte';

/** A single structured filter applied to the catalog. */
export interface CatalogFilter {
  /** A CatalogColumn id. */
  readonly column: string;
  readonly op: FilterOp;
  /** Raw text; numeric columns parse it server-side. */
  readonly value: string;
}

/** A trace file in the catalog. */
export interface TraceEntry {
  /** Absolute real path; stable identity key. */
  readonly key: string;
  readonly rel: string;
  readonly name: string;
  readonly size: number;
  readonly mtimeMs: number;
  /** Present only when a metadata DB is configured and a row matched. */
  readonly metadata?: MetadataRow;
}

/** A sub-directory in the catalog, offered for navigation. */
export interface DirEntry {
  readonly rel: string;
  readonly name: string;
}

/** One page of the trace catalog: the result of browsing, searching, filtering. */
export interface CatalogPage {
  /** Directory being shown, relative to the root ('' is the root itself). */
  readonly dir: string;
  /** Absolute path of the directory being shown. */
  readonly absPath: string;
  /** Parent directory (relative), or null at the root / in selected mode. */
  readonly parent: string | null;
  readonly dirs: readonly DirEntry[];
  readonly traces: readonly TraceEntry[];
  /** Sum of the sizes of every trace on this page. */
  readonly totalSize: number;
  /** True when the page was capped by --max-results. */
  readonly truncated: boolean;
  readonly maxResults: number;
  /** True when the server was launched with an explicit --trace allow-list. */
  readonly selectedMode: boolean;
}

// --- host stats --------------------------------------------------------------

/** A used/total resource pair (host memory, disk, ...). */
export interface ResourceUsage {
  readonly total: number;
  readonly available: number;
  readonly used: number;
}

/** Host-level stats shown in the status bar. */
export interface SystemStats {
  readonly memory: ResourceUsage;
  readonly disk: ResourceUsage & {readonly path: string};
}

// --- top-level state ---------------------------------------------------------

/** Immutable server configuration, surfaced to the UI for display. */
export interface ServerConfig {
  readonly tpBinary: string;
  readonly tracesDir: string;
  readonly bind: string;
  readonly recursiveSearch: boolean;
  /** Inclusive backend port range trace processors are allocated from. */
  readonly tpPortRange: readonly [number, number];
  /** Columns the UI may show, sort, and filter on. */
  readonly columns: readonly CatalogColumn[];
  /** True when a metadata SQLite DB is wired up (enables suggestions). */
  readonly metadataEnabled: boolean;
}

/** Full application snapshot returned by POST /api/state. */
export interface AppState {
  readonly config: ServerConfig;
  readonly catalog: CatalogPage;
  readonly running: readonly RunningChild[];
  readonly system: SystemStats;
}

// --- requests / responses ----------------------------------------------------

/** Body of POST /api/state — selects which catalog page to return. */
export interface StateRequest {
  readonly dir: string;
  readonly query: string;
  readonly filters: readonly CatalogFilter[];
}

/** Response of GET /api/metadata/suggest — autocomplete values for a column. */
export interface SuggestResponse {
  readonly values: readonly string[];
}

/** Result of a single start/stop/prewarm action. */
export interface ActionResult {
  readonly ok: boolean;
  readonly error?: string;
  /** Stable error code for the client to branch on (e.g. 'OUT_OF_PORTS'). */
  readonly code?: string;
}

/** Result of a batch start/stop action. */
export interface BatchResult {
  readonly started?: number;
  readonly stopped?: number;
}

/** Error envelope used for any non-2xx API response. */
export interface ApiError {
  readonly error: string;
}
