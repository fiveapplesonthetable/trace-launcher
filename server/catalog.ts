import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  CatalogColumn,
  CatalogFilter,
  CatalogPage,
  DirEntry,
  FilterOp,
  TraceEntry,
} from '../shared/types';
import type {MetadataStore} from './metadata';

// The catalog is the read-only view of the traces directory: it lists,
// searches, and filters trace files and resolves the paths the UI sends back.
// It owns every filesystem access, and every path it returns has been
// validated to live under the configured root (or in the --trace allow-list).
// When a MetadataStore is wired in it also joins metadata onto each trace and
// delegates metadata-column filtering to SQL.

const TRACE_SUFFIXES = [
  '.pftrace',
  '.pftrace.gz',
  '.trace',
  '.trace.gz',
  '.perfetto-trace',
  '.perfetto-trace.gz',
] as const;

/** Built-in columns derived from the file itself; always available. */
const FILE_COLUMNS: readonly CatalogColumn[] = [
  {
    id: 'rel',
    label: 'Path',
    kind: 'text',
    source: 'file',
    filterable: true,
    defaultVisible: false,
  },
  {
    id: 'size',
    label: 'Size',
    kind: 'number',
    source: 'file',
    filterable: true,
    defaultVisible: true,
  },
  {
    id: 'modified',
    label: 'Modified',
    kind: 'number',
    source: 'file',
    filterable: false,
    defaultVisible: true,
  },
];

/** True if `name` ends in a recognised trace-file suffix. */
export function looksLikeTrace(name: string): boolean {
  const lower = name.toLowerCase();
  return TRACE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** Expands a leading `~` to the user's home directory. */
export function expandUser(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Thrown for any catalog request that names a path the caller may not see. */
export class CatalogError extends Error {}

export class Catalog {
  /** Absolute, symlink-resolved root directory. */
  readonly root: string;
  readonly maxResults: number;
  readonly recursiveSearch: boolean;

  /**
   * When the server is launched with explicit `--trace` paths this holds the
   * resolved allow-list; the catalog then ignores directory structure and only
   * ever exposes those traces. Null means "browse the whole root".
   */
  private readonly allowList: readonly string[] | null;

  constructor(
    tracesDir: string,
    requested: readonly string[],
    maxResults: number,
    recursiveSearch: boolean,
    private readonly metadata?: MetadataStore,
  ) {
    this.root = fs.realpathSync(expandUser(tracesDir));
    this.maxResults = maxResults;
    this.recursiveSearch = recursiveSearch;
    this.allowList =
      requested.length > 0
        ? requested.map((item) => this.resolveRequested(item))
        : null;
  }

  get selectedMode(): boolean {
    return this.allowList !== null;
  }

  /** Every column the UI may show, sort, or filter on. */
  columns(): readonly CatalogColumn[] {
    return this.metadata === undefined
      ? FILE_COLUMNS
      : [...FILE_COLUMNS, ...this.metadata.columns()];
  }

  /**
   * Path of `abs` relative to the root ('' for the root itself), or `abs`
   * unchanged if it escapes the root.
   */
  rel(abs: string): string {
    const relative = path.relative(this.root, abs);
    return relative.startsWith('..') ? abs : relative;
  }

  /** Resolves a UI-supplied relative directory, rejecting anything outside. */
  resolveDir(relDir: string): string {
    if (this.allowList !== null) return this.root;
    const cleaned = relDir.replace(/^[/\\]+|[/\\]+$/g, '');
    const candidate = path.resolve(this.root, cleaned);
    if (!this.isWithinRoot(candidate)) {
      throw new CatalogError('directory is outside the traces root');
    }
    if (!statOrNull(candidate)?.isDirectory()) {
      throw new CatalogError(`not a directory: ${candidate}`);
    }
    return candidate;
  }

  /**
   * Validates a UI-supplied trace key and returns its canonical path. This is
   * the gate every "open" / "stop" request passes through.
   */
  validate(traceKey: string): string {
    let resolved: string;
    try {
      resolved = fs.realpathSync(expandUser(traceKey));
    } catch {
      throw new CatalogError(`trace not found: ${traceKey}`);
    }
    if (this.allowList !== null) {
      if (!this.allowList.includes(resolved)) {
        throw new CatalogError('trace is not in the selected trace set');
      }
    } else if (!this.isWithinRoot(resolved)) {
      throw new CatalogError('trace is outside the traces root');
    }
    if (!statOrNull(resolved)?.isFile()) {
      throw new CatalogError(`trace not found: ${resolved}`);
    }
    if (!looksLikeTrace(path.basename(resolved))) {
      throw new CatalogError(`not a recognised trace file: ${resolved}`);
    }
    return resolved;
  }

  /**
   * Lists one page of the catalog for a search query, directory, and set of
   * structured filters. Candidates are gathered first, then filtered, then
   * sorted, then capped — so a filter can never be hidden by truncation.
   */
  list(
    query: string,
    relDir: string,
    filters: readonly CatalogFilter[] = [],
  ): CatalogPage {
    const needle = query.trim().toLowerCase();
    const browse = this.gather(needle, relDir);

    let entries = browse.candidates.map((abs) => this.entry(abs));
    entries = this.applyFilters(entries, filters);
    entries.sort((a, b) => a.rel.localeCompare(b.rel));

    const truncated = this.maxResults > 0 && entries.length > this.maxResults;
    const traces = truncated ? entries.slice(0, this.maxResults) : entries;

    return {
      dir: browse.dir,
      absPath: browse.absPath,
      parent: browse.parent,
      dirs: browse.dirs,
      traces,
      totalSize: traces.reduce((sum, t) => sum + t.size, 0),
      truncated,
      maxResults: this.maxResults,
      selectedMode: this.allowList !== null,
    };
  }

  // --- internals -------------------------------------------------------------

  /** Walks the filesystem (or the allow-list) to collect candidate traces. */
  private gather(
    needle: string,
    relDir: string,
  ): {
    candidates: string[];
    dirs: DirEntry[];
    dir: string;
    absPath: string;
    parent: string | null;
  } {
    if (this.allowList !== null) {
      const candidates = this.allowList.filter(
        (p) => needle === '' || path.basename(p).toLowerCase().includes(needle),
      );
      return {candidates, dirs: [], dir: '', absPath: this.root, parent: null};
    }

    const currentDir = this.resolveDir(relDir);
    const recursive = needle !== '' && this.recursiveSearch;

    // Sub-directories are only offered while plainly browsing; a search result
    // is a flat list of matching files.
    const dirs: DirEntry[] =
      needle === ''
        ? readDirEntries(currentDir)
            .filter((d) => d.isDirectory())
            .map((d) => ({
              rel: this.rel(path.join(currentDir, d.name)),
              name: d.name,
            }))
            .sort((a, b) => a.name.localeCompare(b.name))
        : [];

    const candidates: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of readDirEntries(dir)) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (recursive) visit(full);
          continue;
        }
        if (!entry.isFile() || !looksLikeTrace(entry.name)) continue;
        if (needle !== '' && !entry.name.toLowerCase().includes(needle)) continue;
        candidates.push(full);
      }
    };
    visit(recursive ? this.root : currentDir);

    return {
      candidates,
      dirs,
      dir: this.rel(currentDir),
      absPath: currentDir,
      parent:
        currentDir === this.root ? null : this.rel(path.dirname(currentDir)),
    };
  }

  /** Applies file-column and metadata-column filters to a list of entries. */
  private applyFilters(
    entries: TraceEntry[],
    filters: readonly CatalogFilter[],
  ): TraceEntry[] {
    let result = entries;
    for (const filter of filters) {
      if (filter.column === 'rel' || filter.column === 'size') {
        result = result.filter((e) => matchesFileFilter(e, filter));
      }
    }
    const metaKeys = this.metadata?.filterKeys(filters) ?? null;
    if (metaKeys !== null) {
      result = result.filter((e) => matchesKeySet(e, metaKeys));
    }
    return result;
  }

  private resolveRequested(item: string): string {
    let candidate = expandUser(item);
    if (!path.isAbsolute(candidate)) candidate = path.join(this.root, candidate);
    if (!statOrNull(candidate)?.isFile()) {
      throw new CatalogError(`trace not found: ${candidate}`);
    }
    if (!looksLikeTrace(path.basename(candidate))) {
      throw new CatalogError(`not a recognised trace file: ${candidate}`);
    }
    return fs.realpathSync(candidate);
  }

  private isWithinRoot(abs: string): boolean {
    return abs === this.root || abs.startsWith(this.root + path.sep);
  }

  private entry(abs: string): TraceEntry {
    const stat = statOrNull(abs);
    const rel = this.rel(abs);
    const name = path.basename(abs);
    const base: TraceEntry = {
      key: abs,
      rel,
      name,
      size: stat?.size ?? 0,
      mtimeMs: stat?.mtimeMs ?? 0,
    };
    if (this.metadata === undefined) return base;
    const metadata = this.metadata.lookup({abs, rel, name});
    return metadata === undefined ? base : {...base, metadata};
  }
}

function statOrNull(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function readDirEntries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, {withFileTypes: true});
  } catch {
    return [];
  }
}

/** Evaluates a `rel` or `size` file-column filter against a trace entry. */
function matchesFileFilter(entry: TraceEntry, filter: CatalogFilter): boolean {
  if (filter.column === 'rel') {
    return matchText(entry.rel, filter.op, filter.value);
  }
  // filter.column === 'size'
  const threshold = parseHumanSize(filter.value);
  if (threshold === null) return false;
  return matchNumber(entry.size, filter.op, threshold);
}

/** True if any of a trace's identifiers is in a metadata key set. */
function matchesKeySet(entry: TraceEntry, keys: ReadonlySet<string>): boolean {
  return keys.has(entry.key) || keys.has(entry.rel) || keys.has(entry.name);
}

function matchText(value: string, op: FilterOp, target: string): boolean {
  const v = value.toLowerCase();
  const t = target.toLowerCase();
  switch (op) {
    case 'contains':
      return v.includes(t);
    case 'equals':
      return v === t;
    case 'gt':
      return v > t;
    case 'gte':
      return v >= t;
    case 'lt':
      return v < t;
    case 'lte':
      return v <= t;
  }
}

function matchNumber(value: number, op: FilterOp, target: number): boolean {
  switch (op) {
    case 'equals':
      return value === target;
    case 'gt':
      return value > target;
    case 'gte':
      return value >= target;
    case 'lt':
      return value < target;
    case 'lte':
      return value <= target;
    case 'contains':
      return String(value).includes(String(target));
  }
}

const SIZE_MULTIPLIERS: Readonly<Record<string, number>> = {
  '': 1,
  b: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
  t: 1024 ** 4,
  tb: 1024 ** 4,
  tib: 1024 ** 4,
};

/** Parses "1048576", "1mb", "1.5 GiB" -> bytes, or null if unparseable. */
export function parseHumanSize(input: string): number | null {
  const match = /^\s*([0-9]*\.?[0-9]+)\s*([a-z]*)\s*$/i.exec(input);
  if (match === null) return null;
  const value = Number(match[1]);
  const multiplier = SIZE_MULTIPLIERS[(match[2] ?? '').toLowerCase()];
  if (multiplier === undefined || !Number.isFinite(value)) return null;
  return value * multiplier;
}
