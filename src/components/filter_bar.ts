import m from 'mithril';
import type {CatalogColumn, FilterOp} from '../../shared/types';
import {store} from '../core/store';
import {Button} from '../widgets/button';
import {Dropdown} from '../widgets/dropdown';
import {Icon} from '../widgets/icon';

// Structured filtering. The "Filters" dropdown hosts a small builder (column /
// operator / value, with autocomplete for metadata text columns) plus the list
// of active filters; active filters also show as removable chips beneath the
// toolbar. File-column filters run in the server process; metadata-column
// filters run as SQL against the metadata DB.

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
const SUGGESTIONS_LIST_ID = 'pf-tl-filter-suggestions';

/**
 * Synthetic column for filtering by runtime state. Not part of the server's
 * config.columns — the actual filtering happens client-side in the store
 * against each trace's live RunningChild status. Listed first so it's the
 * default the editor lands on, which is the most common reason to filter.
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

function opsFor(column: CatalogColumn): readonly FilterOp[] {
  if (column.id === 'status') return STATUS_OPS;
  return column.kind === 'number' ? NUMBER_OPS : TEXT_OPS;
}

function filterableColumns(): readonly CatalogColumn[] {
  return [STATUS_COLUMN, ...store.availableColumns().filter((c) => c.filterable)];
}

function columnLabel(id: string): string {
  if (id === STATUS_COLUMN.id) return STATUS_COLUMN.label;
  return store.availableColumns().find((c) => c.id === id)?.label ?? id;
}

/** The column / operator / value builder inside the Filters dropdown. */
class FilterEditor implements m.ClassComponent {
  private column = '';
  private op: FilterOp = 'contains';
  private value = '';
  private suggestions: readonly string[] = [];
  private suggestTimer: number | undefined;

  view(): m.Children {
    const filterable = filterableColumns();
    // STATUS_COLUMN is always prepended by filterableColumns(), so the array
    // is never empty — but make the invariant a runtime guard rather than a
    // non-null assertion so any future refactor that breaks the invariant
    // fails loudly.
    const selected = filterable.find((c) => c.id === this.column) ?? filterable[0];
    if (selected === undefined) return null;
    if (this.column !== selected.id) {
      this.column = selected.id;
      this.op = opsFor(selected)[0] ?? 'contains';
      this.suggestions = selected.id === 'status' ? STATUS_VALUES : [];
    }
    const ops = opsFor(selected);
    const suggestible = this.isSuggestible(selected);

    return m('.pf-tl-filter-editor', [
      m(
        'select.pf-tl-select',
        {
          'aria-label': 'Filter column',
          value: this.column,
          onchange: (e: Event) =>
            this.selectColumn((e.target as HTMLSelectElement).value, filterable),
        },
        filterable.map((col) => m('option', {value: col.id}, col.label)),
      ),
      m(
        'select.pf-tl-select.pf-tl-filter-editor__op',
        {
          'aria-label': 'Filter operator',
          value: this.op,
          onchange: (e: Event) => {
            this.op = (e.target as HTMLSelectElement).value as FilterOp;
          },
        },
        ops.map((op) => m('option', {value: op}, OP_LABELS[op])),
      ),
      m('input.pf-tl-input.pf-tl-filter-editor__value', {
        type: 'text',
        placeholder: selected.kind === 'number' ? 'value…' : 'text…',
        value: this.value,
        list: suggestible ? SUGGESTIONS_LIST_ID : undefined,
        oninput: (e: Event) => {
          this.value = (e.target as HTMLInputElement).value;
          if (suggestible) this.scheduleSuggest(selected.id);
        },
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter') this.commit();
        },
      }),
      suggestible
        ? m(
            'datalist',
            {id: SUGGESTIONS_LIST_ID},
            this.suggestions.map((value) => m('option', {value})),
          )
        : null,
      m(Button, {
        label: 'Add',
        icon: 'plus',
        intent: 'primary',
        compact: true,
        disabled: this.value.trim() === '',
        onclick: () => this.commit(),
      }),
    ]);
  }

  private selectColumn(
    id: string,
    filterable: readonly CatalogColumn[],
  ): void {
    const column = filterable.find((c) => c.id === id);
    if (column === undefined) return;
    this.column = id;
    this.op = opsFor(column)[0] ?? 'contains';
    this.value = '';
    this.suggestions = id === 'status' ? STATUS_VALUES : [];
  }

  private isSuggestible(column: CatalogColumn): boolean {
    if (column.id === 'status') return true;
    return (
      column.source === 'metadata' &&
      column.kind === 'text' &&
      (store.state?.config.metadataEnabled ?? false)
    );
  }

  private scheduleSuggest(columnId: string): void {
    if (columnId === 'status') {
      this.suggestions = STATUS_VALUES;
      return;
    }
    window.clearTimeout(this.suggestTimer);
    this.suggestTimer = window.setTimeout(() => {
      void store
        .suggest(columnId, this.value)
        .then((values) => {
          this.suggestions = values;
          m.redraw();
        })
        .catch(() => {
          this.suggestions = [];
        });
    }, SUGGEST_DEBOUNCE_MS);
  }

  private commit(): void {
    const value = this.value.trim();
    if (value === '') return;
    store.addFilter({column: this.column, op: this.op, value});
    this.value = '';
    this.suggestions = [];
  }
}

/** The "Filters" dropdown trigger + builder + active-filter list. */
export class FilterControl implements m.ClassComponent {
  view(): m.Children {
    const filters = store.filters;
    return m(
      Dropdown,
      {
        label: 'Filters',
        icon: 'filter',
        badge: filters.length,
        panelClass: 'pf-tl-filter-panel',
      },
      [
        m('.pf-tl-filter-panel__title', 'Add a filter'),
        m(FilterEditor),
        filters.length > 0
          ? m('.pf-tl-filter-panel__active', [
              m('.pf-tl-filter-panel__active-head', [
                m('span', 'Active filters'),
                m(Button, {
                  label: 'Clear all',
                  variant: 'minimal',
                  compact: true,
                  onclick: () => store.clearFilters(),
                }),
              ]),
              filters.map((filter, index) =>
                m('.pf-tl-filter-row', [
                  m('span.pf-tl-filter-row__text', [
                    m('strong', columnLabel(filter.column)),
                    ` ${OP_LABELS[filter.op]} `,
                    m('code', filter.value),
                  ]),
                  m(Button, {
                    icon: 'close',
                    variant: 'minimal',
                    compact: true,
                    title: 'Remove filter',
                    onclick: () => store.removeFilter(index),
                  }),
                ]),
              ),
            ])
          : null,
      ],
    );
  }
}

/** The strip of removable chips shown beneath the toolbar for active filters. */
export class FilterChips implements m.ClassComponent {
  view(): m.Children {
    const filters = store.filters;
    if (filters.length === 0) return null;
    return m(
      '.pf-tl-filter-chips',
      filters.map((filter, index) =>
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
                title: 'Remove filter',
                'aria-label': `Remove filter ${columnLabel(filter.column)} ${filter.op} ${filter.value}`,
                onclick: () => store.removeFilter(index),
              },
              m(Icon, {icon: 'close', size: 12}),
            ),
          ],
        ),
      ),
    );
  }
}
