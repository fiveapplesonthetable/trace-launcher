import m from 'mithril';
import type {CatalogColumn, ColumnKind, FilterOp} from '../../shared/types';
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
const SUGGEST_DEBOUNCE_MS = 140;
const SUGGESTIONS_LIST_ID = 'tl-filter-suggestions';

function opsFor(kind: ColumnKind): readonly FilterOp[] {
  return kind === 'number' ? NUMBER_OPS : TEXT_OPS;
}

function columnLabel(id: string): string {
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
    const filterable = store.availableColumns().filter((c) => c.filterable);
    if (filterable.length === 0) {
      return m('.tl-filter-editor__empty', 'No filterable columns available.');
    }
    // Keep the editor's column in sync with what the server actually offers.
    const selected = filterable.find((c) => c.id === this.column) ?? filterable[0]!;
    if (this.column !== selected.id) {
      this.column = selected.id;
      this.op = opsFor(selected.kind)[0] ?? 'contains';
    }
    const ops = opsFor(selected.kind);
    const suggestible = this.isSuggestible(selected);

    return m('.tl-filter-editor', [
      m(
        'select.tl-select',
        {
          'aria-label': 'Filter column',
          value: this.column,
          onchange: (e: Event) =>
            this.selectColumn((e.target as HTMLSelectElement).value, filterable),
        },
        filterable.map((col) => m('option', {value: col.id}, col.label)),
      ),
      m(
        'select.tl-select.tl-filter-editor__op',
        {
          'aria-label': 'Filter operator',
          value: this.op,
          onchange: (e: Event) => {
            this.op = (e.target as HTMLSelectElement).value as FilterOp;
          },
        },
        ops.map((op) => m('option', {value: op}, OP_LABELS[op])),
      ),
      m('input.tl-input.tl-filter-editor__value', {
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
    this.op = opsFor(column.kind)[0] ?? 'contains';
    this.value = '';
    this.suggestions = [];
  }

  private isSuggestible(column: CatalogColumn): boolean {
    return (
      column.source === 'metadata' &&
      column.kind === 'text' &&
      (store.state?.config.metadataEnabled ?? false)
    );
  }

  private scheduleSuggest(columnId: string): void {
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
        panelClass: 'tl-filter-panel',
      },
      [
        m('.tl-filter-panel__title', 'Add a filter'),
        m(FilterEditor),
        filters.length > 0
          ? m('.tl-filter-panel__active', [
              m('.tl-filter-panel__active-head', [
                m('span', 'Active filters'),
                m(Button, {
                  label: 'Clear all',
                  variant: 'minimal',
                  compact: true,
                  onclick: () => store.clearFilters(),
                }),
              ]),
              filters.map((filter, index) =>
                m('.tl-filter-row', [
                  m('span.tl-filter-row__text', [
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
      '.tl-filter-chips',
      filters.map((filter, index) =>
        m(
          '.tl-chip-filter',
          {key: `${index}:${filter.column}:${filter.op}:${filter.value}`},
          [
            m('span.tl-chip-filter__text', [
              m('strong', columnLabel(filter.column)),
              ` ${OP_LABELS[filter.op]} `,
              filter.value,
            ]),
            m(
              'button.tl-chip-filter__remove',
              {
                title: 'Remove filter',
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
