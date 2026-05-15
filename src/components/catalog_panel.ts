import m from 'mithril';
import type {
  CatalogColumn,
  DirEntry,
  MetadataValue,
  RunningChild,
  TraceEntry,
} from '../../shared/types';
import {rowStateFor, store} from '../core/store';
import {formatRelativeTime, formatSize} from '../base/format';
import {Button} from '../widgets/button';
import {Icon} from '../widgets/icon';
import {MiddleEllipsis} from '../widgets/middle_ellipsis';
import {ProgressBar} from '../widgets/progress_bar';
import {ColumnPicker} from './column_picker';
import {FilterChips, SearchFilterBar} from './filter_bar';

// The catalog: a configurable-column table of trace files for the current
// directory / search / filters. Directories are listed first for navigation;
// each trace row carries its live status and start/stop actions, with an
// inline progress bar while an action is in flight.
//
// We render every row the server returns — no client-side cap. Off-screen
// rows are skipped from layout + paint by the browser via the
// `content-visibility: auto` rule in app.scss (see `.pf-tl-table tbody tr`).
// This delivers virtual-scroll-grade performance for catalogs into the
// thousands without the bookkeeping cost of a hand-rolled windowed
// renderer.

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
    // At root there are no segments — DirInfo already shows the
    // absolute path on the next line. Rendering just `🏠 root` adds
    // visual noise without telling the user anything new.
    if (catalog.dir === '') return null;

    const segments = catalog.dir.split('/');
    const crumbs: m.Child[] = [
      m(
        'button.pf-tl-crumb',
        {onclick: () => store.navigateTo('')},
        m(Icon, {icon: 'home', size: 14}),
        'root',
      ),
    ];
    let acc = '';
    segments.forEach((segment, i) => {
      acc = acc === '' ? segment : `${acc}/${segment}`;
      const target = acc;
      crumbs.push(
        m(Icon, {icon: 'chevronRight', size: 13, className: 'pf-tl-crumb__sep'}),
      );
      crumbs.push(
        i === segments.length - 1
          ? m('span.pf-tl-crumb.pf-tl-crumb--current', segment)
          : m(
              'button.pf-tl-crumb',
              {onclick: () => store.navigateTo(target)},
              segment,
            ),
      );
    });
    return m('.pf-tl-breadcrumb', crumbs);
  }
}

/**
 * The thin meta-row that sits immediately above the table: the
 * absolute trace path on the left, a short "5 traces · 121 KiB" digest
 * in the middle, and the Columns visibility picker on the right.
 *
 * Putting Columns here puts it next to what it controls — the table —
 * instead of cluttering the search/filter row above. The search bar
 * can then span the full width.
 */
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
    const shown = catalog.traces.length;
    const total = catalog.unfilteredCount;
    const narrowed = total > 0 && shown < total;
    if (narrowed) {
      facts.push(`${shown} / ${total} traces`);
    } else {
      facts.push(shown === 1 ? '1 trace' : `${shown} traces`);
    }
    facts.push(`${formatSize(catalog.totalSize)} total`);

    return m('.pf-tl-dirinfo', [
      m('.pf-tl-dirinfo__path', {title: catalog.absPath}, [
        m(Icon, {icon: 'folder', size: 13}),
        m(MiddleEllipsis, {text: catalog.absPath, endChars: 22}),
      ]),
      m('.pf-tl-dirinfo__facts', facts.join('  ·  ')),
      m('.pf-tl-dirinfo__tools', m(ColumnPicker)),
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
    const activate = (): void => store.navigateTo(dir.rel);
    return m(
      'tr.pf-tl-tr.pf-tl-tr--dir',
      {
        // Keyboard-activatable folder row: a button would be ideal but tables
        // need <tr>s, so we ape button semantics with role + aria-label.
        role: 'button',
        'aria-label': `Open folder ${dir.name}`,
        tabindex: 0,
        onclick: activate,
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            activate();
          }
        },
      },
      [
        m(
          'td.pf-tl-td.pf-tl-td--actions',
          m(
            '.pf-tl-actions',
            m(Icon, {icon: 'chevronRight', size: 16, className: 'pf-tl-chevron'}),
          ),
        ),
        m(
          'td.pf-tl-td.pf-tl-td--name',
          m('.pf-tl-name-cell', [
            m(
              '.pf-tl-row-icon.pf-tl-row-icon--dir',
              m(Icon, {icon: 'folder', size: 17}),
            ),
            m('span.pf-tl-name-cell__text', dir.name),
          ]),
        ),
        ...range(columnCount).map(() => m('td.pf-tl-td.pf-tl-td--dim', '—')),
        m('td.pf-tl-td.pf-tl-td--dim', '—'), // memory placeholder
        m('td.pf-tl-td.pf-tl-td--dim', ''),  // status placeholder
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

    // When the row's rel path includes a directory prefix (recursive search
    // hit, or browsing showed deep results), surface that prefix above the
    // basename so the user can place the file in its tree without losing
    // basename readability. Plain in-directory listings keep the original
    // basename-only layout.
    const parentDir = trace.rel.includes('/')
      ? trace.rel.slice(0, trace.rel.lastIndexOf('/'))
      : '';
    // Once the child is live the basename links straight to ui.perfetto.dev
    // wired to its RPC port — the single most common follow-up action gets
    // a one-click affordance directly on the file name, not buried behind
    // a hover state on a secondary icon.
    const openUrl =
      child !== undefined && child.status === 'live'
        ? child.perfettoUrl
        : undefined;
    const basename = m(MiddleEllipsis, {
      text: trace.name,
      endChars: 14,
      className: 'pf-tl-name-cell__text',
    });

    return m(`tr.pf-tl-tr.pf-tl-tr--trace${busy ? '.pf-tl-tr--busy' : ''}`, [
      m(
        'td.pf-tl-td.pf-tl-td--actions',
        m('.pf-tl-actions', this.action(trace, child, pending)),
      ),
      m(
        'td.pf-tl-td.pf-tl-td--name',
        m('.pf-tl-name-cell', [
          m('.pf-tl-row-icon', m(Icon, {icon: 'file', size: 16})),
          m('.pf-tl-name-cell__stack', [
            parentDir !== ''
              ? m(
                  '.pf-tl-name-cell__parent',
                  {title: parentDir},
                  m(MiddleEllipsis, {text: parentDir, endChars: 18}),
                )
              : null,
            openUrl !== undefined
              ? m(
                  'a.pf-tl-name-cell__link',
                  {
                    href: openUrl,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    title: `Open ${trace.name} in ui.perfetto.dev (rpc :${child?.port})`,
                  },
                  basename,
                )
              : basename,
          ]),
        ]),
      ),
      ...columns.map((col) => m('td.pf-tl-td', this.cell(trace, col))),
      m('td.pf-tl-td.pf-tl-td--memory', this.memoryCell(child)),
      m('td.pf-tl-td.pf-tl-td--status', this.statusCell(trace, child, busy)),
    ]);
  }

  private cell(trace: TraceEntry, col: CatalogColumn): m.Children {
    if (col.id === 'rel') {
      return m(MiddleEllipsis, {
        text: trace.rel,
        endChars: 16,
        className: 'pf-tl-cell-mono',
      });
    }
    if (col.id === 'size') {
      return m('span.pf-tl-cell-num', formatSize(trace.size));
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
        col.kind === 'number' ? 'span.pf-tl-cell-num' : 'span',
        metaText(value),
      );
    }
    return '—';
  }

  private statusCell(
    trace: TraceEntry,
    child: RunningChild | undefined,
    busy: boolean,
  ): m.Children {
    // The status cell stays single-line. A Start/Stop API error surfaces
    // as a compact inline chip beside the state chip with the full
    // message in `title`, *not* on a second line.
    const actionError = store.errorFor(trace.key);
    return m('.pf-tl-status-cell', [
      this.chip(child),
      actionError !== undefined
        ? m(
            '.pf-tl-row-error',
            {
              title: actionError.message,
              role: 'alert',
              'aria-live': 'polite',
            },
            [
              m(Icon, {icon: 'alert', size: 12}),
              m(
                'button.pf-tl-row-error__close',
                {
                  title: 'Dismiss',
                  'aria-label': 'Dismiss error',
                  onclick: () => store.clearError(trace.key),
                },
                m(Icon, {icon: 'close', size: 11}),
              ),
            ],
          )
        : null,
      busy ? m(ProgressBar, {className: 'pf-tl-status-cell__progress'}) : null,
    ]);
  }

  /** Memory cell: the running child's RSS, or em-dash if idle / crashed. */
  private memoryCell(child: RunningChild | undefined): m.Children {
    if (
      child === undefined ||
      child.status === 'crashed' ||
      child.rssBytes <= 0
    ) {
      return m('span.pf-tl-cell-dim', '—');
    }
    return m(
      'span.pf-tl-cell-num',
      {title: 'Resident set size for this trace_processor'},
      formatSize(child.rssBytes),
    );
  }

  private chip(child: RunningChild | undefined): m.Children {
    // The "no child" case is handled first so the rest of the switch
    // can reference child.port without a non-null assertion.
    if (child === undefined) return m('span.pf-tl-state.pf-tl-state--idle', 'idle');
    const state = rowStateFor(child);
    switch (state) {
      case 'idle':
        // rowStateFor only returns 'idle' for child === undefined, which we
        // handled above. This case is unreachable but keeps the switch total.
        return m('span.pf-tl-state.pf-tl-state--idle', 'idle');
      case 'live':
        return m('span.pf-tl-state.pf-tl-state--live', `live :${child.port}`);
      case 'starting':
        return m('span.pf-tl-state.pf-tl-state--starting', 'starting');
      case 'crashed':
        return m('span.pf-tl-state.pf-tl-state--crashed', this.crashedLabel(child));
    }
  }

  /** Human label for a crashed child — surfaces the signal if it OOM'd. */
  private crashedLabel(child: RunningChild): string {
    if (child.exit?.signal === 'SIGKILL') return 'killed';
    if (child.exit?.signal !== null && child.exit?.signal !== undefined) {
      return `crashed (${child.exit.signal})`;
    }
    if (child.exit?.code !== null && child.exit?.code !== undefined && child.exit.code !== 0) {
      return `crashed (exit ${child.exit.code})`;
    }
    return 'crashed';
  }

  private action(
    trace: TraceEntry,
    child: RunningChild | undefined,
    pending: boolean,
  ): m.Children {
    // Two icon-only buttons in a fixed-width slot, so column alignment is
    // preserved row-to-row no matter the state. Button 1 is a Start/Stop
    // toggle; button 2 is Open-in-Perfetto for a live child, or Dismiss
    // for a crashed one, or nothing for an idle row.
    return [
      this.primaryButton(trace, child, pending),
      this.secondaryButton(trace, child),
    ];
  }

  /** Start, Stop, Cancel, or Retry — whichever the current state allows. */
  private primaryButton(
    trace: TraceEntry,
    child: RunningChild | undefined,
    pending: boolean,
  ): m.Children {
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
    if (child.status === 'crashed') {
      return m(Button, {
        icon: 'refresh',
        intent: 'primary',
        variant: 'outlined',
        compact: true,
        title: 'Retry',
        loading: pending,
        onclick: () => void store.open(trace.key),
      });
    }
    return m(Button, {
      icon: 'stop',
      intent: 'danger',
      variant: 'outlined',
      compact: true,
      title: child.status === 'starting' ? 'Cancel' : 'Stop',
      loading: pending,
      onclick: () => void store.stop(trace.key),
    });
  }

  /** Open-in-Perfetto for a live child, Dismiss for a crashed one,
   *  otherwise a fixed-width spacer so action-column widths line up. */
  private secondaryButton(
    trace: TraceEntry,
    child: RunningChild | undefined,
  ): m.Children {
    if (child === undefined) return m('.pf-tl-actions__spacer');
    if (child.status === 'crashed') {
      return m(Button, {
        icon: 'close',
        variant: 'minimal',
        compact: true,
        title: 'Dismiss',
        onclick: () => void store.stop(trace.key),
      });
    }
    if (child.status === 'live') {
      return m(Button, {
        icon: 'external',
        intent: 'primary',
        variant: 'outlined',
        compact: true,
        title: `Open in ui.perfetto.dev (rpc :${child.port})`,
        href: child.perfettoUrl,
        target: '_blank',
      });
    }
    return m('.pf-tl-actions__spacer');
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
    const hasRows = dirs.length > 0 || traces.length > 0;

    return m('section.pf-tl-panel', [
      this.head(traces.length),
      this.toolbar(),
      m(FilterChips),
      m(Breadcrumb),
      m(DirInfo),
      catalog?.truncated === true
        ? m('.pf-tl-note', [
            m(Icon, {icon: 'alert', size: 14}),
            `Showing the server's first ${catalog.maxResults} matches — ` +
              'narrow the search or add filters to see the rest.',
          ])
        : null,
      hasRows
        ? m(
            '.pf-tl-table-wrap',
            m('table.pf-tl-table', [
              this.header(columns),
              m('tbody', [
                ...dirs.map((dir) =>
                  m(DirRow, {
                    key: `dir:${dir.rel}`,
                    dir,
                    columnCount: columns.length,
                  }),
                ),
                ...traces.map((trace) =>
                  m(TraceRow, {key: `trace:${trace.key}`, trace, columns}),
                ),
              ]),
            ]),
          )
        : state !== null
          ? this.empty()
          : null,
    ]);
  }

  private head(traceCount: number): m.Children {
    return m('.pf-tl-panel__head', [
      m('.pf-tl-panel__title', [
        m('span', 'Catalog'),
        m('span.pf-tl-badge', store.state !== null ? String(traceCount) : '…'),
      ]),
      m('.pf-tl-panel__head-actions', [
        m(Button, {
          label: 'Start all shown',
          icon: 'play',
          variant: 'outlined',
          compact: true,
          disabled: traceCount === 0,
          onclick: () => void store.startVisible(),
        }),
        m(Button, {
          label: 'Open all shown',
          icon: 'external',
          variant: 'outlined',
          compact: true,
          disabled: store.visibleLiveCount() === 0,
          title:
            'Open every live trace in this view in its own ui.perfetto.dev ' +
            'tab. Rows not yet started are skipped — start them first.',
          onclick: () => store.openVisible(),
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
    // Search bar gets the whole row now — the table-column-visibility
    // Columns picker has moved down to DirInfo, right next to the
    // table it controls.
    return m('.pf-tl-toolbar', m(SearchFilterBar));
  }

  private header(columns: readonly CatalogColumn[]): m.Children {
    const sortHeader = (id: string, label: string): m.Children => {
      const sort = store.sort;
      const active = sort !== null && sort.column === id;
      const ariaSort = active
        ? sort.direction === 'asc' ? 'ascending' : 'descending'
        : 'none';
      const activate = (): void => store.setSort(id);
      return m(
        'th.pf-tl-th.pf-tl-th--sortable',
        {
          class: active ? 'pf-tl-th--active' : undefined,
          'aria-sort': ariaSort,
          tabindex: 0,
          onclick: activate,
          onkeydown: (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              activate();
            }
          },
        },
        m('.pf-tl-th__inner', [
          m('span', label),
          active
            ? m(Icon, {
                icon: sort.direction === 'asc' ? 'arrowUp' : 'arrowDown',
                size: 14,
              })
            : null,
        ]),
      );
    };
    return m(
      'thead',
      m('tr', [
        m('th.pf-tl-th.pf-tl-th--actions', {'aria-label': 'Actions'}, ''),
        sortHeader('name', 'Name'),
        ...columns.map((col) => sortHeader(col.id, col.label)),
        m('th.pf-tl-th.pf-tl-th--memory', 'Memory'),
        m('th.pf-tl-th', 'Status'),
      ]),
    );
  }

  private empty(): m.Children {
    const searching = store.query !== '' || store.filters.length > 0;
    return m('.pf-tl-empty', [
      m(Icon, {icon: 'search', size: 26, className: 'pf-tl-empty__icon'}),
      m(
        'p.pf-tl-empty__title',
        searching ? 'No traces match' : 'No traces in this directory',
      ),
      searching
        ? m(
            'p.pf-tl-empty__hint',
            'Try a different search term or remove a filter.',
          )
        : null,
    ]);
  }
}
