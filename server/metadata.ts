import path from 'node:path';

import Database from 'better-sqlite3';

import type {
  CatalogColumn,
  CatalogFilter,
  ColumnKind,
  FilterOp,
  MetadataRow,
  MetadataValue,
} from '../shared/types';

// Optional metadata layer. When the server is started with --metadata-db this
// joins each trace to a row of the given table and exposes that table for
// column display, SQL-backed filtering, and value autocomplete.
//
// Safety: identifiers (table and column names) are validated against a strict
// pattern before they ever reach a SQL string; every user-supplied value is
// bound as a parameter.

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Column names tried, in order, when --metadata-key-column is not given. */
const KEY_COLUMN_CANDIDATES = [
  'path',
  'trace_path',
  'trace',
  'file',
  'filepath',
  'filename',
  'name',
] as const;
const SUGGEST_LIMIT = 25;

export class MetadataError extends Error {}

interface RawColumn {
  readonly name: string;
  readonly kind: ColumnKind;
}

/** A trace reduced to the identifiers a metadata row might be keyed by. */
export interface TraceKeyParts {
  readonly abs: string;
  readonly rel: string;
  readonly name: string;
}

export class MetadataStore {
  private readonly db: Database.Database;
  private readonly table: string;
  private readonly keyColumn: string;
  private readonly rawColumns: readonly RawColumn[];
  /** Every metadata row, indexed by key value and basename for fast joins. */
  private readonly rowsByKey = new Map<string, MetadataRow>();

  constructor(dbPath: string, table: string, keyColumn: string | undefined) {
    if (!IDENTIFIER.test(table)) {
      throw new MetadataError(`invalid --metadata-table name: ${table}`);
    }
    try {
      this.db = new Database(dbPath, {readonly: true, fileMustExist: true});
    } catch (err) {
      throw new MetadataError(
        `cannot open metadata DB ${dbPath}: ${messageOf(err)}`,
      );
    }
    this.table = table;
    this.rawColumns = this.readColumns();
    this.keyColumn = this.resolveKeyColumn(keyColumn);
    this.loadRows();
  }

  /** The metadata columns, as catalog columns the UI can show / filter. */
  columns(): CatalogColumn[] {
    return this.rawColumns.map((col) => ({
      id: `meta:${col.name}`,
      label: col.name,
      kind: col.kind,
      source: 'metadata' as const,
      filterable: true,
      defaultVisible: false,
    }));
  }

  /** The metadata row joined to a trace, or undefined if none matched. */
  lookup(trace: TraceKeyParts): MetadataRow | undefined {
    return (
      this.rowsByKey.get(trace.abs) ??
      this.rowsByKey.get(trace.rel) ??
      this.rowsByKey.get(trace.name)
    );
  }

  /**
   * Runs the metadata-column filters as one SQL query and returns the set of
   * trace identifiers that match. Returns null when there are no metadata
   * filters at all (meaning "no metadata constraint", not "nothing matched").
   */
  filterKeys(filters: readonly CatalogFilter[]): Set<string> | null {
    const metadataFilters = filters.filter((f) => f.column.startsWith('meta:'));
    if (metadataFilters.length === 0) return null;

    const clauses: string[] = [];
    const params: MetadataValue[] = [];
    for (const filter of metadataFilters) {
      const column = this.rawColumns.find(
        (c) => c.name === filter.column.slice('meta:'.length),
      );
      if (column === undefined) continue; // unknown column — ignore this filter
      const {sql, param} = compilePredicate(column, filter.op, filter.value);
      clauses.push(sql);
      params.push(param);
    }
    if (clauses.length === 0) return new Set();

    const sql =
      `SELECT "${this.keyColumn}" AS k FROM "${this.table}" ` +
      `WHERE ${clauses.join(' AND ')}`;
    const rows = this.db.prepare(sql).all(...params) as Array<{k: MetadataValue}>;

    const matched = new Set<string>();
    for (const row of rows) {
      if (row.k === null) continue;
      const value = String(row.k);
      matched.add(value);
      matched.add(path.basename(value));
    }
    return matched;
  }

  /** Distinct values of a column starting with `prefix`, for autocomplete. */
  suggest(columnId: string, prefix: string): string[] {
    const name = columnId.startsWith('meta:')
      ? columnId.slice('meta:'.length)
      : columnId;
    const column = this.rawColumns.find((c) => c.name === name);
    if (column === undefined) return [];
    const sql =
      `SELECT DISTINCT "${column.name}" AS v FROM "${this.table}" ` +
      `WHERE "${column.name}" IS NOT NULL ` +
      `AND CAST("${column.name}" AS TEXT) LIKE ? ESCAPE '\\' ` +
      `ORDER BY v LIMIT ${SUGGEST_LIMIT}`;
    const rows = this.db
      .prepare(sql)
      .all(`${escapeLike(prefix)}%`) as Array<{v: MetadataValue}>;
    return rows
      .map((r) => (r.v === null ? '' : String(r.v)))
      .filter((v) => v !== '');
  }

  close(): void {
    this.db.close();
  }

  // --- internals -------------------------------------------------------------

  private readColumns(): RawColumn[] {
    let info: Array<{name: unknown; type: unknown}>;
    try {
      info = this.db.pragma(`table_info("${this.table}")`) as Array<{
        name: unknown;
        type: unknown;
      }>;
    } catch (err) {
      throw new MetadataError(
        `cannot read table ${this.table}: ${messageOf(err)}`,
      );
    }
    if (info.length === 0) {
      throw new MetadataError(`metadata table not found: ${this.table}`);
    }
    const columns: RawColumn[] = [];
    for (const entry of info) {
      const name = String(entry.name);
      if (!IDENTIFIER.test(name)) continue; // skip columns we cannot quote safely
      columns.push({name, kind: sqliteKind(String(entry.type))});
    }
    return columns;
  }

  private resolveKeyColumn(requested: string | undefined): string {
    if (requested !== undefined) {
      if (!this.rawColumns.some((c) => c.name === requested)) {
        throw new MetadataError(
          `--metadata-key-column "${requested}" is not a column of ${this.table}`,
        );
      }
      return requested;
    }
    for (const candidate of KEY_COLUMN_CANDIDATES) {
      if (this.rawColumns.some((c) => c.name === candidate)) return candidate;
    }
    throw new MetadataError(
      `could not guess the trace-path column of ${this.table}; ` +
        'pass --metadata-key-column explicitly',
    );
  }

  private loadRows(): void {
    const rows = this.db
      .prepare(`SELECT * FROM "${this.table}"`)
      .all() as MetadataRow[];
    for (const row of rows) {
      const keyValue = row[this.keyColumn];
      if (keyValue === null || keyValue === undefined) continue;
      const key = String(keyValue);
      this.rowsByKey.set(key, row);
      // Also index by basename so a DB of absolute paths still joins to traces
      // addressed by name, and vice versa.
      const base = path.basename(key);
      if (!this.rowsByKey.has(base)) this.rowsByKey.set(base, row);
    }
  }
}

/** Maps a SQLite declared column type onto our text/number split. */
function sqliteKind(declaredType: string): ColumnKind {
  const t = declaredType.toUpperCase();
  const numeric =
    t.includes('INT') ||
    t.includes('REAL') ||
    t.includes('FLOA') ||
    t.includes('DOUB') ||
    t.includes('NUM') ||
    t.includes('DEC');
  return numeric ? 'number' : 'text';
}

/** Builds one parameterised WHERE clause for a metadata filter. */
function compilePredicate(
  column: RawColumn,
  op: FilterOp,
  value: string,
): {sql: string; param: MetadataValue} {
  const col = `"${column.name}"`;
  if (column.kind === 'number') {
    if (op === 'contains') {
      return {
        sql: `CAST(${col} AS TEXT) LIKE ? ESCAPE '\\'`,
        param: `%${escapeLike(value)}%`,
      };
    }
    const num = Number(value);
    if (!Number.isFinite(num)) {
      throw new MetadataError(
        `"${value}" is not a number for column ${column.name}`,
      );
    }
    return {sql: `${col} ${numericOperator(op)} ?`, param: num};
  }
  // Text column.
  switch (op) {
    case 'contains':
      return {
        sql: `${col} LIKE ? ESCAPE '\\'`,
        param: `%${escapeLike(value)}%`,
      };
    case 'equals':
      return {sql: `${col} = ?`, param: value};
    case 'gt':
      return {sql: `${col} > ?`, param: value};
    case 'gte':
      return {sql: `${col} >= ?`, param: value};
    case 'lt':
      return {sql: `${col} < ?`, param: value};
    case 'lte':
      return {sql: `${col} <= ?`, param: value};
  }
}

function numericOperator(op: Exclude<FilterOp, 'contains'>): string {
  switch (op) {
    case 'equals':
      return '=';
    case 'gt':
      return '>';
    case 'gte':
      return '>=';
    case 'lt':
      return '<';
    case 'lte':
      return '<=';
  }
}

/** Escapes LIKE wildcards so user input is matched literally (with ESCAPE '\'). */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
