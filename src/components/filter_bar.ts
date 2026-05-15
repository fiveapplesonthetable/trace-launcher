import m from 'mithril';
import type {CatalogColumn, FilterOp} from '../../shared/types';
import {store} from '../core/store';
import {Icon} from '../widgets/icon';

// Structured filtering. Sits as its own row immediately below the search
// bar:
//
//   [Status: live ×] [Device: pixel-7 ×] [+ Add filter]
//
// Clicking the trailing "+ Add filter" pill expands a builder card *inline*
// directly below the chip row — no popover, no tiny browser datalist, no
// hidden dropdowns. The builder shows:
//   - a horizontal segmented control for the column
//   - operator + value side by side (value field is the widest control)
//   - a generously-sized suggestion list pinned beneath the value, with
//     the active suggestion highlighted and Enter / arrow-key navigation
//
// File-column filters run in the Node server process; metadata-column
// filters compile to parameterised SQL against the metadata DB; the
// synthetic "status" column applies client-side against each row's live
// child status.

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
 * against each trace's live RunningChild status. Listed first so it lands
 * as the builder's default, which is the most common reason to filter.
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

/**
 * Returns the static suggestion list for a column (status enum) or null
 * when suggestions must come from the metadata DB over the network.
 */
function staticSuggestions(column: CatalogColumn): readonly string[] | null {
  if (column.id === 'status') return STATUS_VALUES;
  return null;
}

function dynamicallySuggestible(column: CatalogColumn): boolean {
  return (
    column.source === 'metadata' &&
    column.kind === 'text' &&
    (store.state?.config.metadataEnabled ?? false)
  );
}

/** The expanding inline builder card. Self-contained: opens, commits, closes. */
class FilterBuilder
  implements m.ClassComponent<{onClose: () => void}>
{
  private column = '';
  private op: FilterOp = 'contains';
  private value = '';
  private suggestions: readonly string[] = [];
  private highlight = -1;
  private suggestTimer: number | undefined;
  private valueInputDom: HTMLInputElement | null = null;

  oncreate(): void {
    // Focus straight into the value input on open. The user has already
    // committed to "I'm adding a filter"; landing the caret in the only
    // input they actually have to fill in is the smallest path to commit.
    this.valueInputDom?.focus();
  }

  onremove(): void {
    window.clearTimeout(this.suggestTimer);
  }

  view({attrs}: m.CVnode<{onClose: () => void}>): m.Children {
    const filterable = filterableColumns();
    // filterableColumns() always prepends STATUS_COLUMN — empty would be
    // an invariant violation, but we guard rather than non-null-assert so
    // any future refactor that breaks it fails loudly.
    const selected = filterable.find((c) => c.id === this.column) ?? filterable[0];
    if (selected === undefined) return null;
    if (this.column !== selected.id) {
      this.column = selected.id;
      this.op = opsFor(selected)[0] ?? 'contains';
      this.suggestions = staticSuggestions(selected) ?? [];
    }
    const ops = opsFor(selected);
    const staticSugg = staticSuggestions(selected);
    const visibleSuggestions = this.suggestions;
    const hasSuggestions = visibleSuggestions.length > 0;

    return m('.pf-tl-fb', [
      // ── column picker (segmented control) ──────────────────────────────
      m(
        '.pf-tl-fb__cols',
        {role: 'tablist', 'aria-label': 'Filter column'},
        filterable.map((col) =>
          m(
            'button.pf-tl-fb__col',
            {
              role: 'tab',
              'aria-selected': col.id === selected.id ? 'true' : 'false',
              class: col.id === selected.id ? 'pf-tl-fb__col--active' : '',
              onclick: () => this.selectColumn(col.id, filterable),
            },
            col.label,
          ),
        ),
      ),
      // ── op + value + Add ───────────────────────────────────────────────
      m('.pf-tl-fb__row', [
        m(
          'select.pf-tl-select.pf-tl-fb__op',
          {
            'aria-label': 'Filter operator',
            value: this.op,
            onchange: (e: Event) => {
              this.op = (e.target as HTMLSelectElement).value as FilterOp;
            },
          },
          ops.map((op) => m('option', {value: op}, OP_LABELS[op])),
        ),
        m('input.pf-tl-input.pf-tl-fb__value', {
          type: 'text',
          spellcheck: false,
          autocomplete: 'off',
          placeholder: selected.kind === 'number' ? 'value…' : 'text…',
          value: this.value,
          oncreate: (vn: m.VnodeDOM) => {
            this.valueInputDom = vn.dom as HTMLInputElement;
          },
          oninput: (e: Event) => {
            this.value = (e.target as HTMLInputElement).value;
            this.highlight = -1;
            this.refreshSuggestions(selected);
            // Defer the redraw to the debounced suggestion fetch when we
            // need the network; this also avoids one redraw per keystroke.
            (e as Event & {redraw?: boolean}).redraw = false;
            m.redraw();
          },
          onkeydown: (e: KeyboardEvent) => this.onKey(e, visibleSuggestions),
        }),
        m(
          'button.pf-tl-fb__add',
          {
            disabled: this.value.trim() === '',
            onclick: () => this.commit(attrs.onClose),
          },
          'Add',
        ),
        m(
          'button.pf-tl-fb__cancel',
          {
            title: 'Cancel (Esc)',
            'aria-label': 'Cancel',
            onclick: attrs.onClose,
          },
          m(Icon, {icon: 'close', size: 14}),
        ),
      ]),
      // ── suggestions ─────────────────────────────────────────────────────
      hasSuggestions
        ? m(
            '.pf-tl-fb__suggest',
            {
              role: 'listbox',
              'aria-label':
                staticSugg !== null
                  ? `${selected.label} values`
                  : `${selected.label} suggestions`,
            },
            visibleSuggestions.map((value, i) =>
              m(
                'button.pf-tl-fb__suggest-item',
                {
                  role: 'option',
                  'aria-selected': i === this.highlight ? 'true' : 'false',
                  class:
                    i === this.highlight ? 'pf-tl-fb__suggest-item--active' : '',
                  onmousedown: (e: MouseEvent) => {
                    // Use mousedown so the input doesn't lose focus before
                    // we read the click — onclick fires after blur on some
                    // browsers and would dismiss the suggestion list first.
                    e.preventDefault();
                    this.value = value;
                    this.commit(attrs.onClose);
                  },
                },
                value,
              ),
            ),
          )
        : null,
    ]);
  }

  private onKey(e: KeyboardEvent, list: readonly string[]): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      return;
    }
    if (list.length === 0) {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.commit(() => {});
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.highlight = Math.min(list.length - 1, this.highlight + 1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.highlight = Math.max(-1, this.highlight - 1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (this.highlight >= 0 && this.highlight < list.length) {
        const picked = list[this.highlight] as string;
        this.value = picked;
      }
      this.commit(() => {});
      return;
    }
  }

  private selectColumn(id: string, all: readonly CatalogColumn[]): void {
    const col = all.find((c) => c.id === id);
    if (col === undefined) return;
    this.column = id;
    this.op = opsFor(col)[0] ?? 'contains';
    this.value = '';
    this.highlight = -1;
    this.suggestions = staticSuggestions(col) ?? [];
    // Defer fetch until user starts typing for metadata text columns —
    // running suggest() with an empty prefix on every column switch is
    // wasted load, especially with a big metadata table.
    this.valueInputDom?.focus();
  }

  /** Picks the right suggestion source for the selected column. */
  private refreshSuggestions(column: CatalogColumn): void {
    const fixed = staticSuggestions(column);
    if (fixed !== null) {
      // Filter the static list by the partial input so a user typing
      // `cra` sees only `crashed`. Cheap, keeps the list useful.
      const q = this.value.trim().toLowerCase();
      this.suggestions = q === '' ? fixed : fixed.filter((v) => v.toLowerCase().includes(q));
      return;
    }
    if (!dynamicallySuggestible(column)) {
      this.suggestions = [];
      return;
    }
    window.clearTimeout(this.suggestTimer);
    this.suggestTimer = window.setTimeout(() => {
      void store
        .suggest(column.id, this.value)
        .then((values) => {
          this.suggestions = values;
          m.redraw();
        })
        .catch(() => {
          this.suggestions = [];
        });
    }, SUGGEST_DEBOUNCE_MS);
  }

  private commit(close: () => void): void {
    const value = this.value.trim();
    if (value === '') return;
    store.addFilter({column: this.column, op: this.op, value});
    this.value = '';
    this.suggestions = staticSuggestions(
      filterableColumns().find((c) => c.id === this.column) ?? STATUS_COLUMN,
    ) ?? [];
    this.highlight = -1;
    close();
  }
}

/**
 * The filter bar that sits immediately under the search bar.
 *
 * Always rendered. Carries the active filter chips, a trailing "+ Add
 * filter" pill, and (when expanded) the inline builder card. Hides
 * entirely only when there is nothing to show *and* the builder is
 * closed — i.e. an empty catalog with no filters has no clutter.
 */
export class FilterBar implements m.ClassComponent {
  private open = false;

  view(): m.Children {
    const filters = store.filters;
    const hasFilters = filters.length > 0;
    // Tucking the bar away when there is nothing to show keeps the empty
    // state spacious — but the moment the user has any filter, or has
    // opened the builder, the bar is sticky so they can edit/close it.
    if (!hasFilters && !this.open) {
      return m('.pf-tl-filterbar', m('.pf-tl-filterbar__chips', this.addPill()));
    }
    // Mithril requires every element in a child array to be either all
    // keyed or all unkeyed — mixing crashes the diff. The chips have
    // natural keys; the trailing pill / Clear-all get sentinel keys so
    // the array stays homogeneous as filters come and go.
    const items: m.Children[] = filters.map((filter, index) =>
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
    );
    items.push(m.fragment({key: '__add'}, [this.addPill()]));
    if (hasFilters) {
      items.push(
        m(
          'button.pf-tl-filterbar__clear',
          {key: '__clear', onclick: () => store.clearFilters()},
          'Clear all',
        ),
      );
    }
    return m('.pf-tl-filterbar', [
      m('.pf-tl-filterbar__chips', items),
      this.open
        ? m(FilterBuilder, {onClose: () => this.toggle(false)})
        : null,
    ]);
  }

  /** The trailing "+ Add filter" pill. Style stays consistent with chips so
   *  it reads as the obvious next slot to fill. */
  private addPill(): m.Children {
    return m(
      'button.pf-tl-filterbar__add',
      {
        class: this.open ? 'pf-tl-filterbar__add--active' : '',
        'aria-expanded': this.open ? 'true' : 'false',
        onclick: () => this.toggle(!this.open),
      },
      [m(Icon, {icon: 'plus', size: 12}), m('span', 'Add filter')],
    );
  }

  private toggle(next: boolean): void {
    this.open = next;
  }
}
