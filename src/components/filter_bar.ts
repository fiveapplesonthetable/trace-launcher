import m from 'mithril';
import type {CatalogColumn, FilterOp} from '../../shared/types';
import {store} from '../core/store';
import {Icon} from '../widgets/icon';

// A single search bar that doubles as the filter builder.
//
// In its default mode the bar is exactly the free-text search a user
// expects on a catalog: type, results narrow. A leading "[Column ▾]"
// chip inside the bar lets the user point the bar at a different
// column — Status, Path, Size, any metadata column. When a structured
// column is selected, a small op chip appears next to it (is / contains
// / =, >, <, …) and the input becomes the value field, with a real
// suggestion list pinned beneath. Enter commits the filter as a chip
// in the row below; the bar resets to free-text mode for the next
// query.
//
// Pattern reference: Slack's channel selector inside its search bar,
// Linear's filter pills, Notion's per-field filter row. Single input,
// context dictated by a leading dropdown, structured commits emit
// chips that persist.

const FREE_TEXT_COLUMN_ID = 'name';

const OP_LABELS: Readonly<Record<FilterOp, string>> = {
  contains: 'contains',
  equals: 'is',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
};
const TEXT_OPS: readonly FilterOp[] = ['contains', 'equals'];
const NUMBER_OPS: readonly FilterOp[] = ['equals', 'gte', 'lte', 'gt', 'lt'];
const STATUS_OPS: readonly FilterOp[] = ['equals'];
const SUGGEST_DEBOUNCE_MS = 140;

/**
 * Synthetic column for filtering by runtime state. Not part of the server's
 * config.columns — the actual filtering happens client-side in the store
 * against each trace's live RunningChild status.
 */
const STATUS_COLUMN: CatalogColumn = {
  id: 'status',
  label: 'Status',
  kind: 'text',
  source: 'file',
  filterable: true,
  defaultVisible: false,
};
const STATUS_VALUES: readonly string[] = [
  'idle',
  'starting',
  'live',
  'crashed',
];

/**
 * Synthetic "column" representing the default free-text search. Picking
 * it puts the bar into store.query mode; it never gets committed as a
 * chip.
 */
const FREE_TEXT_COLUMN: CatalogColumn = {
  id: FREE_TEXT_COLUMN_ID,
  label: 'Search',
  kind: 'text',
  source: 'file',
  filterable: false,
  defaultVisible: false,
};

function isFreeText(c: CatalogColumn): boolean {
  return c.id === FREE_TEXT_COLUMN_ID;
}

function opsFor(column: CatalogColumn): readonly FilterOp[] {
  if (column.id === STATUS_COLUMN.id) return STATUS_OPS;
  return column.kind === 'number' ? NUMBER_OPS : TEXT_OPS;
}

function filterableColumns(): readonly CatalogColumn[] {
  return [STATUS_COLUMN, ...store.availableColumns().filter((c) => c.filterable)];
}

function columnLabel(id: string): string {
  if (id === STATUS_COLUMN.id) return STATUS_COLUMN.label;
  return store.availableColumns().find((c) => c.id === id)?.label ?? id;
}

function staticSuggestions(column: CatalogColumn): readonly string[] | null {
  if (column.id === STATUS_COLUMN.id) return STATUS_VALUES;
  return null;
}

function dynamicallySuggestible(column: CatalogColumn): boolean {
  return (
    column.source === 'metadata' &&
    column.kind === 'text' &&
    (store.state?.config.metadataEnabled ?? false)
  );
}

/**
 * A small chip-styled dropdown trigger that opens an anchored menu of
 * options. Used for the [Column ▾] and [op ▾] chips inside the search
 * bar; styled to look like an inline pill that's part of the bar.
 */
interface InlinePickAttrs<T> {
  readonly options: ReadonlyArray<{readonly value: T; readonly label: string}>;
  readonly value: T;
  readonly onpick: (value: T) => void;
  readonly variant?: 'context' | 'op';
}

class InlinePick<T extends string> implements m.ClassComponent<InlinePickAttrs<T>> {
  private open = false;
  private readonly onDocDown = (e: MouseEvent): void => {
    if (!this.open) return;
    const target = e.target as Element | null;
    if (target !== null && (target.closest('.pf-tl-pick') as Element | null) !== null) {
      // Click is inside this dropdown — let normal handlers run, don't
      // dismiss. The inner option mousedown handles selection.
      return;
    }
    this.setOpen(false);
    m.redraw();
  };
  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.open) {
      this.setOpen(false);
      m.redraw();
    }
  };

  onremove(): void {
    document.removeEventListener('mousedown', this.onDocDown, true);
    document.removeEventListener('keydown', this.onKey);
  }

  view({attrs}: m.CVnode<InlinePickAttrs<T>>): m.Children {
    const current =
      attrs.options.find((o) => o.value === attrs.value)?.label ?? String(attrs.value);
    const variant = attrs.variant ?? 'context';
    return m(
      `.pf-tl-pick.pf-tl-pick--${variant}`,
      {class: this.open ? 'pf-tl-pick--open' : ''},
      [
        m(
          'button.pf-tl-pick__trigger',
          {
            type: 'button',
            'aria-haspopup': 'listbox',
            'aria-expanded': this.open ? 'true' : 'false',
            onclick: (e: MouseEvent) => {
              e.stopPropagation();
              this.setOpen(!this.open);
            },
          },
          [
            m('span.pf-tl-pick__label', current),
            m(Icon, {icon: 'chevronDown', size: 11, className: 'pf-tl-pick__chev'}),
          ],
        ),
        this.open
          ? m(
              '.pf-tl-pick__menu',
              {role: 'listbox'},
              attrs.options.map((opt) =>
                m(
                  'button.pf-tl-pick__item',
                  {
                    type: 'button',
                    role: 'option',
                    'aria-selected': opt.value === attrs.value ? 'true' : 'false',
                    class:
                      opt.value === attrs.value ? 'pf-tl-pick__item--active' : '',
                    onmousedown: (e: MouseEvent) => {
                      // mousedown so we react before the document-mousedown
                      // dismiss handler runs.
                      e.preventDefault();
                      e.stopPropagation();
                      attrs.onpick(opt.value);
                      this.setOpen(false);
                    },
                  },
                  opt.label,
                ),
              ),
            )
          : null,
      ],
    );
  }

  private setOpen(open: boolean): void {
    if (open === this.open) return;
    this.open = open;
    if (open) {
      // capture-phase so we see clicks before they trigger blurs etc.
      document.addEventListener('mousedown', this.onDocDown, true);
      document.addEventListener('keydown', this.onKey);
    } else {
      document.removeEventListener('mousedown', this.onDocDown, true);
      document.removeEventListener('keydown', this.onKey);
    }
  }
}

/**
 * The combined search + filter builder. Owns the active editor column,
 * operator, pending value, and the live suggestion list. When the
 * editor column is "name" the bar drives store.query; for any other
 * column it builds a structured filter that commits to store.filters.
 */
export class SearchFilterBar implements m.ClassComponent {
  private editorColumn: CatalogColumn = FREE_TEXT_COLUMN;
  private editorOp: FilterOp = 'contains';
  private pendingValue = '';
  private suggestions: readonly string[] = [];
  private highlight = -1;
  private suggestTimer: number | undefined;
  /** Tracks the DOM input so we can refocus after a dropdown pick. */
  private inputDom: HTMLInputElement | null = null;

  onremove(): void {
    window.clearTimeout(this.suggestTimer);
  }

  view(): m.Children {
    const recursive = store.state?.config.recursiveSearch ?? false;
    const cols = filterableColumns();
    const columnOptions = [
      {value: FREE_TEXT_COLUMN_ID, label: 'Search (any field)'},
      ...cols.map((c) => ({value: c.id, label: c.label})),
    ];
    const free = isFreeText(this.editorColumn);
    const ops = free ? [] : opsFor(this.editorColumn);
    const opOptions = ops.map((op) => ({value: op, label: OP_LABELS[op]}));
    const sugg = this.suggestions;
    const inputValue = free ? store.query : this.pendingValue;
    const placeholder = free
      ? recursive
        ? 'Search every trace under the root…'
        : 'Search traces in this directory…'
      : `Type a ${this.editorColumn.label.toLowerCase()}…`;

    return m('.pf-tl-sfb', [
      // ── leading column picker — the "context" of the search bar ────
      m<InlinePickAttrs<string>, unknown>(InlinePick, {
        variant: 'context',
        value: this.editorColumn.id,
        options: columnOptions,
        onpick: (id) => this.selectColumn(id, cols),
      }),
      // ── operator picker (only for structured columns) ───────────────
      free
        ? null
        : m<InlinePickAttrs<FilterOp>, unknown>(InlinePick, {
            variant: 'op',
            value: this.editorOp,
            options: opOptions,
            onpick: (op: FilterOp) => {
              this.editorOp = op;
              this.inputDom?.focus();
            },
          }),
      m(Icon, {icon: 'search', size: 15, className: 'pf-tl-sfb__icon'}),
      m('input.pf-tl-sfb__input', {
        type: 'search',
        spellcheck: false,
        autocomplete: 'off',
        placeholder,
        value: inputValue,
        oncreate: (vn: m.VnodeDOM) => {
          this.inputDom = vn.dom as HTMLInputElement;
        },
        oninput: (e: Event) => {
          const v = (e.target as HTMLInputElement).value;
          if (free) {
            store.setQuery(v);
            // The store's debounce will refresh and redraw on its own;
            // suppressing the per-keystroke redraw keeps typing smooth.
            (e as Event & {redraw?: boolean}).redraw = false;
          } else {
            this.pendingValue = v;
            this.highlight = -1;
            this.refreshSuggestions();
            (e as Event & {redraw?: boolean}).redraw = false;
            m.redraw();
          }
        },
        onkeydown: (e: KeyboardEvent) => this.onKey(e, sugg),
      }),
      // ── commit button — only meaningful for structured filters ────
      free
        ? null
        : m(
            'button.pf-tl-sfb__commit',
            {
              type: 'button',
              disabled: this.pendingValue.trim() === '',
              title: 'Apply filter (Enter)',
              onclick: () => this.commit(),
            },
            [
              m('span', 'Apply'),
              m(Icon, {icon: 'chevronRight', size: 12}),
            ],
          ),
      // ── suggestion list (rendered as an absolute panel by CSS) ─────
      !free && sugg.length > 0
        ? m(
            '.pf-tl-sfb__suggest',
            {role: 'listbox', 'aria-label': `${this.editorColumn.label} suggestions`},
            sugg.map((v, i) =>
              m(
                'button.pf-tl-sfb__suggest-item',
                {
                  type: 'button',
                  role: 'option',
                  'aria-selected': i === this.highlight ? 'true' : 'false',
                  class:
                    i === this.highlight ? 'pf-tl-sfb__suggest-item--active' : '',
                  onmousedown: (e: MouseEvent) => {
                    e.preventDefault();
                    this.pendingValue = v;
                    this.commit();
                  },
                },
                v,
              ),
            ),
          )
        : null,
    ]);
  }

  private onKey(e: KeyboardEvent, list: readonly string[]): void {
    if (e.key === 'Escape') {
      // Esc in free-text mode is a no-op; in structured mode it
      // cancels the in-progress filter back to free-text.
      if (!isFreeText(this.editorColumn)) {
        e.preventDefault();
        this.resetToFreeText();
      }
      return;
    }
    if (isFreeText(this.editorColumn)) return;
    if (list.length > 0 && e.key === 'ArrowDown') {
      e.preventDefault();
      this.highlight = Math.min(list.length - 1, this.highlight + 1);
      return;
    }
    if (list.length > 0 && e.key === 'ArrowUp') {
      e.preventDefault();
      this.highlight = Math.max(-1, this.highlight - 1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (this.highlight >= 0 && this.highlight < list.length) {
        const picked = list[this.highlight] as string;
        this.pendingValue = picked;
      }
      this.commit();
      return;
    }
  }

  /** Switch the bar's editor column. Clears the pending value: the
   *  user is changing context, not narrowing the same value. */
  private selectColumn(id: string, all: readonly CatalogColumn[]): void {
    if (id === FREE_TEXT_COLUMN_ID) {
      this.resetToFreeText();
      return;
    }
    const col = all.find((c) => c.id === id);
    if (col === undefined) return;
    this.editorColumn = col;
    this.editorOp = opsFor(col)[0] ?? 'contains';
    this.pendingValue = '';
    this.highlight = -1;
    this.suggestions = staticSuggestions(col) ?? [];
    // Async-focus to give Mithril a tick to render the input.
    setTimeout(() => this.inputDom?.focus(), 0);
  }

  private refreshSuggestions(): void {
    const col = this.editorColumn;
    const fixed = staticSuggestions(col);
    if (fixed !== null) {
      const q = this.pendingValue.trim().toLowerCase();
      this.suggestions =
        q === '' ? fixed : fixed.filter((v) => v.toLowerCase().includes(q));
      return;
    }
    if (!dynamicallySuggestible(col)) {
      this.suggestions = [];
      return;
    }
    window.clearTimeout(this.suggestTimer);
    this.suggestTimer = window.setTimeout(() => {
      void store
        .suggest(col.id, this.pendingValue)
        .then((values) => {
          // Race-guard: only apply if the user hasn't switched columns
          // since this request started.
          if (this.editorColumn.id === col.id) {
            this.suggestions = values;
            m.redraw();
          }
        })
        .catch(() => {
          this.suggestions = [];
        });
    }, SUGGEST_DEBOUNCE_MS);
  }

  private commit(): void {
    const value = this.pendingValue.trim();
    if (value === '' || isFreeText(this.editorColumn)) return;
    store.addFilter({
      column: this.editorColumn.id,
      op: this.editorOp,
      value,
    });
    this.resetToFreeText();
  }

  private resetToFreeText(): void {
    this.editorColumn = FREE_TEXT_COLUMN;
    this.editorOp = 'contains';
    this.pendingValue = '';
    this.suggestions = [];
    this.highlight = -1;
    setTimeout(() => this.inputDom?.focus(), 0);
  }
}

/**
 * The row of removable chips for committed structured filters. Sits
 * directly under the search bar. Hidden entirely when no filters are
 * active so the empty state stays clean.
 */
export class FilterChips implements m.ClassComponent {
  view(): m.Children {
    const filters = store.filters;
    if (filters.length === 0) return null;
    return m(
      '.pf-tl-chips',
      [
        ...filters.map((filter, index) =>
          m(
            '.pf-tl-chip-filter',
            {key: `${index}:${filter.column}:${filter.op}:${filter.value}`},
            [
              m('span.pf-tl-chip-filter__text', [
                m('strong', columnLabel(filter.column)),
                ` ${OP_LABELS[filter.op]} `,
                filter.value,
              ]),
              m(
                'button.pf-tl-chip-filter__remove',
                {
                  type: 'button',
                  title: 'Remove filter',
                  'aria-label': `Remove filter ${columnLabel(filter.column)} ${filter.op} ${filter.value}`,
                  onclick: () => store.removeFilter(index),
                },
                m(Icon, {icon: 'close', size: 12}),
              ),
            ],
          ),
        ),
        m(
          'button.pf-tl-chips__clear',
          {key: '__clear', type: 'button', onclick: () => store.clearFilters()},
          'Clear all',
        ),
      ],
    );
  }
}
