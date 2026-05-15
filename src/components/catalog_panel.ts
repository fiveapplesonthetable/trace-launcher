import m from 'mithril';
import type {
  CatalogColumn,
  DirEntry,
  MetadataValue,
  RunningChild,
  TraceEntry,
} from '../../shared/types';
import {store} from '../core/store';
import {formatRelativeTime, formatSize} from '../base/format';
import {Button} from '../widgets/button';
import {Icon} from '../widgets/icon';
import {MiddleEllipsis} from '../widgets/middle_ellipsis';
import {ProgressBar} from '../widgets/progress_bar';
import {ColumnPicker} from './column_picker';
import {FilterChips, FilterControl} from './filter_bar';

// The catalog: a configurable-column table of trace files for the current
// directory / search / filters. Directories are listed first for navigation;
// each trace row carries its live status and start/stop actions, with an
// inline progress bar while an action is in flight.

/** Cap on rendered trace rows — keeps the DOM light on very large catalogs. */
const RENDER_CAP = 600;

function range(n: number): readonly number[] {
  return Array.from({length: Math.max(0, n)}, (_, i) => i);
}

function metaText(value: MetadataValue | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

class Breadcrumb implements m.ClassComponent {
  view(): m.Children {
    const catalog = store.state?.catalog;
    if (catalog === undefined || catalog.selectedMode) return null;

    const segments = catalog.dir === '' ? [] : catalog.dir.split('/');
    const crumbs: m.Child[] = [
      m(
        'button.tl-crumb',
        {disabled: catalog.dir === '', onclick: () => store.navigateTo('')},
        m(Icon, {icon: 'home', size: 14}),
        'root',
      ),
    ];
    let acc = '';
    segments.forEach((segment, i) => {
      acc = acc === '' ? segment : `${acc}/${segment}`;
      const target = acc;
      crumbs.push(
        m(Icon, {icon: 'chevronRight', size: 13, className: 'tl-crumb__sep'}),
      );
      crumbs.push(
        i === segments.length - 1
          ? m('span.tl-crumb.tl-crumb--current', segment)
          : m(
              'button.tl-crumb',
              {onclick: () => store.navigateTo(target)},
              segment,
            ),
      );
    });
    return m('.tl-breadcrumb', crumbs);
  }
}

class DirInfo implements m.ClassComponent {
  view(): m.Children {
    const catalog = store.state?.catalog;
    if (catalog === undefined) return null;

    const facts: string[] = [];
    if (!catalog.selectedMode) {
      facts.push(
        catalog.dirs.length === 1
          ? '1 directory'
          : `${catalog.dirs.length} directories`,
      );
    }
    facts.push(
      catalog.traces.length === 1
        ? '1 trace'
        : `${catalog.traces.length} traces`,
    );
    facts.push(`${formatSize(catalog.totalSize)} total`);

    return m('.tl-dirinfo', [
      m('.tl-dirinfo__path', {title: catalog.absPath}, [
        m(Icon, {icon: 'folder', size: 13}),
        m(MiddleEllipsis, {text: catalog.absPath, endChars: 22}),
      ]),
      m('.tl-dirinfo__facts', facts.join('  ·  ')),
    ]);
  }
}

class DirRow
  implements m.ClassComponent<{dir: DirEntry; columnCount: number}>
{
  view({
    attrs,
  }: m.CVnode<{dir: DirEntry; columnCount: number}>): m.Children {
    const {dir, columnCount} = attrs;
    return m(
      'tr.tl-tr.tl-tr--dir',
      {
        tabindex: 0,
        onclick: () => store.navigateTo(dir.rel),
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') store.navigateTo(dir.rel);
        },
      },
      [
        m(
          'td.tl-td.tl-td--actions',
          m(
            '.tl-actions',
            m(Icon, {icon: 'chevronRight', size: 16, className: 'tl-chevron'}),
          ),
        ),
        m(
          'td.tl-td.tl-td--name',
          m('.tl-name-cell', [
            m(
              '.tl-row-icon.tl-row-icon--dir',
              m(Icon, {icon: 'folder', size: 17}),
            ),
            m('span.tl-name-cell__text', dir.name),
          ]),
        ),
        ...range(columnCount).map(() => m('td.tl-td.tl-td--dim', '—')),
        m('td.tl-td.tl-td--dim', ''),
      ],
    );
  }
}

class TraceRow
  implements
    m.ClassComponent<{trace: TraceEntry; columns: readonly CatalogColumn[]}>
{
  view({
    attrs,
  }: m.CVnode<{
    trace: TraceEntry;
    columns: readonly CatalogColumn[];
  }>): m.Children {
    const {trace, columns} = attrs;
    const child = store.runningFor(trace.key);
    const pending = store.isPending(trace.key);
    const busy = pending || child?.status === 'starting';

    return m(`tr.tl-tr.tl-tr--trace${busy ? '.tl-tr--busy' : ''}`, [
      m(
        'td.tl-td.tl-td--actions',
        m('.tl-actions', this.action(trace, child, pending)),
      ),
      m(
        'td.tl-td.tl-td--name',
        m('.tl-name-cell', [
          m('.tl-row-icon', m(Icon, {icon: 'file', size: 16})),
          m(MiddleEllipsis, {
            text: trace.name,
            endChars: 14,
            className: 'tl-name-cell__text',
          }),
        ]),
      ),
      ...columns.map((col) => m('td.tl-td', this.cell(trace, col))),
      m('td.tl-td.tl-td--status', this.statusCell(child, busy)),
    ]);
  }

  private cell(trace: TraceEntry, col: CatalogColumn): m.Children {
    if (col.id === 'rel') {
      return m(MiddleEllipsis, {
        text: trace.rel,
        endChars: 16,
        className: 'tl-cell-mono',
      });
    }
    if (col.id === 'size') {
      return m('span.tl-cell-num', formatSize(trace.size));
    }
    if (col.id === 'modified') {
      return m(
        'span',
        {title: new Date(trace.mtimeMs).toLocaleString()},
        formatRelativeTime(trace.mtimeMs),
      );
    }
    if (col.id.startsWith('meta:')) {
      const value = trace.metadata?.[col.id.slice('meta:'.length)];
      return m(
        col.kind === 'number' ? 'span.tl-cell-num' : 'span',
        metaText(value),
      );
    }
    return '—';
  }

  private statusCell(
    child: RunningChild | undefined,
    busy: boolean,
  ): m.Children {
    return m('.tl-status-cell', [
      this.chip(child),
      busy ? m(ProgressBar, {className: 'tl-status-cell__progress'}) : null,
    ]);
  }

  private chip(child: RunningChild | undefined): m.Children {
    if (child === undefined) {
      return m('span.tl-state.tl-state--idle', 'idle');
    }
    switch (child.status) {
      case 'live':
        return m('span.tl-state.tl-state--live', `live :${child.port}`);
      case 'starting':
        return m('span.tl-state.tl-state--starting', 'starting');
      case 'crashed':
        return m('span.tl-state.tl-state--crashed', 'crashed');
    }
  }

  private action(
    trace: TraceEntry,
    child: RunningChild | undefined,
    pending: boolean,
  ): m.Children {
    // The action cell holds up to two icon-only buttons in a fixed-width
    // slot, so column alignment is preserved row-to-row regardless of state.
    // Live and crashed rows get a primary + secondary pair; idle and starting
    // rows get just one.
    if (child === undefined) {
      return m(Button, {
        icon: 'play',
        intent: 'success',
        variant: 'outlined',
        compact: true,
        title: 'Start',
        loading: pending,
        onclick: () => void store.open(trace.key),
      });
    }
    if (child.status === 'starting') {
      return m(Button, {
        icon: 'stop',
        intent: 'danger',
        variant: 'outlined',
        compact: true,
        title: 'Cancel',
        loading: pending,
        onclick: () => void store.stop(trace.key),
      });
    }
    if (child.status === 'crashed') {
      return [
        m(Button, {
          icon: 'refresh',
          intent: 'primary',
          variant: 'outlined',
          compact: true,
          title: 'Retry',
          loading: pending,
          onclick: () => void store.open(trace.key),
        }),
        m(Button, {
          icon: 'close',
          variant: 'minimal',
          compact: true,
          title: 'Dismiss',
          onclick: () => void store.stop(trace.key),
        }),
      ];
    }
    // live
    return [
      m(Button, {
        icon: 'external',
        intent: 'primary',
        variant: 'outlined',
        compact: true,
        title: 'Open in Perfetto',
        href: child.perfettoUrl,
        target: '_blank',
      }),
      m(Button, {
        icon: 'stop',
        intent: 'danger',
        variant: 'outlined',
        compact: true,
        title: 'Stop',
        loading: pending,
        onclick: () => void store.stop(trace.key),
      }),
    ];
  }
}

export class CatalogPanel implements m.ClassComponent {
  view(): m.Children {
    const state = store.state;
    const catalog = state?.catalog;
    const traces = store.sortedTraces();
    const dirs = catalog?.dirs ?? [];
    const columns = store
      .availableColumns()
      .filter((c) => store.columnIsVisible(c.id));
    const rendered = traces.slice(0, RENDER_CAP);
    const hasRows = dirs.length > 0 || traces.length > 0;

    return m('section.tl-panel', [
      this.head(traces.length),
      this.toolbar(),
      m(FilterChips),
      m(Breadcrumb),
      m(DirInfo),
      catalog?.truncated === true
        ? m('.tl-note', [
            m(Icon, {icon: 'alert', size: 14}),
            `Showing the server's first ${catalog.maxResults} matches — ` +
              'narrow the search or add filters to see the rest.',
          ])
        : null,
      hasRows
        ? m(
            '.tl-table-wrap',
            m('table.tl-table', [
              this.header(columns),
              m('tbody', [
                ...dirs.map((dir) =>
                  m(DirRow, {
                    key: `dir:${dir.rel}`,
                    dir,
                    columnCount: columns.length,
                  }),
                ),
                ...rendered.map((trace) =>
                  m(TraceRow, {key: `trace:${trace.key}`, trace, columns}),
                ),
              ]),
            ]),
          )
        : state !== null
          ? this.empty()
          : null,
      traces.length > rendered.length
        ? m(
            '.tl-note',
            `Showing ${rendered.length} of ${traces.length} matches — ` +
              'refine the search or filters to narrow the list.',
          )
        : null,
    ]);
  }

  private head(traceCount: number): m.Children {
    return m('.tl-panel__head', [
      m('.tl-panel__title', [
        m('span', 'Catalog'),
        m('span.tl-badge', store.state !== null ? String(traceCount) : '…'),
      ]),
      m('.tl-panel__head-actions', [
        m(Button, {
          label: 'Start all shown',
          icon: 'play',
          variant: 'outlined',
          compact: true,
          disabled: traceCount === 0,
          onclick: () => void store.startVisible(),
        }),
        m(Button, {
          label: 'Stop all shown',
          icon: 'stop',
          variant: 'outlined',
          compact: true,
          disabled: traceCount === 0,
          onclick: () => void store.stopVisible(),
        }),
      ]),
    ]);
  }

  private toolbar(): m.Children {
    const recursive = store.state?.config.recursiveSearch ?? false;
    return m('.tl-toolbar', [
      m('.tl-search', [
        m(Icon, {icon: 'search', size: 16, className: 'tl-search__icon'}),
        m('input.tl-search__input', {
          type: 'search',
          spellcheck: false,
          placeholder: recursive
            ? 'Search every trace under the root…'
            : 'Search traces in this directory…',
          value: store.query,
          oninput: (e: Event) => {
            store.setQuery((e.target as HTMLInputElement).value);
            // Skip the per-keystroke redraw; the debounced refresh redraws.
            (e as Event & {redraw?: boolean}).redraw = false;
          },
        }),
      ]),
      m('.tl-toolbar__tools', [m(FilterControl), m(ColumnPicker)]),
    ]);
  }

  private header(columns: readonly CatalogColumn[]): m.Children {
    const sortHeader = (id: string, label: string): m.Children => {
      const active = store.sort.column === id;
      return m(
        'th.tl-th.tl-th--sortable',
        {
          class: active ? 'tl-th--active' : undefined,
          onclick: () => store.setSort(id),
        },
        m('.tl-th__inner', [
          m('span', label),
          active
            ? m(Icon, {
                icon: store.sort.direction === 'asc' ? 'arrowUp' : 'arrowDown',
                size: 14,
              })
            : null,
        ]),
      );
    };
    return m(
      'thead',
      m('tr', [
        m('th.tl-th.tl-th--actions', ''),
        sortHeader('name', 'Name'),
        ...columns.map((col) => sortHeader(col.id, col.label)),
        m('th.tl-th', 'Status'),
      ]),
    );
  }

  private empty(): m.Children {
    const searching = store.query !== '' || store.filters.length > 0;
    return m('.tl-empty', [
      m(Icon, {icon: 'search', size: 26, className: 'tl-empty__icon'}),
      m(
        'p.tl-empty__title',
        searching ? 'No traces match' : 'No traces in this directory',
      ),
      searching
        ? m(
            'p.tl-empty__hint',
            'Try a different search term or remove a filter.',
          )
        : null,
    ]);
  }
}
