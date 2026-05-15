import m from 'mithril';
import type {RunningChild} from '../../shared/types';
import {store} from '../core/store';
import {formatDuration, formatRelativeTime, formatSize} from '../base/format';
import {Button} from '../widgets/button';
import {Icon} from '../widgets/icon';
import {MiddleEllipsis} from '../widgets/middle_ellipsis';
import {ProgressBar} from '../widgets/progress_bar';

// The "Running" panel: one card per trace_processor child, including ones that
// crashed (so a failed start is never silent). A busy card shows an inline
// indeterminate progress bar so start/stop always feels responsive.

/** How long a child may sit in 'starting' before we flag it as slow. */
const SLOW_START_MS = 8000;

class ChildCard implements m.ClassComponent<{child: RunningChild}> {
  view({attrs}: m.CVnode<{child: RunningChild}>): m.Children {
    const {child} = attrs;
    const pending = store.isPending(child.key);
    const busy = pending || child.status === 'starting';

    return m(`.tl-child.tl-child--${child.status}`, [
      m('.tl-child__top', [
        m('.tl-child__status', [
          m(`span.tl-dot.tl-dot--${child.status}`),
          m('span', this.statusLabel(child)),
        ]),
        child.status !== 'crashed'
          ? m('code.tl-chip', `:${child.port}`)
          : null,
      ]),
      m(MiddleEllipsis, {text: child.name, className: 'tl-child__name'}),
      m(MiddleEllipsis, {
        text: child.rel,
        endChars: 16,
        className: 'tl-child__rel',
      }),
      m('.tl-child__metrics', this.metrics(child)),
      m('.tl-child__actions', this.actions(child, pending)),
      busy
        ? m(ProgressBar, {className: 'tl-child__progress'})
        : m('.tl-child__progress-spacer'),
    ]);
  }

  private statusLabel(child: RunningChild): string {
    switch (child.status) {
      case 'live':
        return 'Live';
      case 'starting':
        return Date.now() - child.startedMs > SLOW_START_MS
          ? 'Starting — slow'
          : 'Starting';
      case 'crashed': {
        const exit = child.exit;
        if (exit === undefined) return 'Exited';
        if (exit.signal !== null) return `Crashed · ${exit.signal}`;
        if (exit.code !== null && exit.code !== 0) {
          return `Exited · code ${exit.code}`;
        }
        return 'Exited';
      }
    }
  }

  private metrics(child: RunningChild): m.Children {
    const metric = (label: string, value: string): m.Children =>
      m('span.tl-metric', [m('em', label), value]);

    if (child.status === 'crashed') {
      return [
        metric('pid', String(child.pid)),
        metric('exited', formatRelativeTime(child.exit?.exitedMs ?? 0)),
        metric('trace', formatSize(child.traceSize)),
      ];
    }
    return [
      metric('pid', String(child.pid)),
      metric('age', formatDuration(Date.now() - child.startedMs)),
      metric('rss', formatSize(child.rssBytes)),
      metric('trace', formatSize(child.traceSize)),
    ];
  }

  private actions(child: RunningChild, pending: boolean): m.Children {
    if (child.status === 'crashed') {
      return [
        m(Button, {
          label: 'Retry',
          icon: 'refresh',
          intent: 'primary',
          compact: true,
          loading: pending,
          onclick: () => void store.open(child.key),
        }),
        m(Button, {
          label: 'Dismiss',
          icon: 'close',
          variant: 'minimal',
          compact: true,
          onclick: () => void store.stop(child.key),
        }),
      ];
    }
    const live = child.status === 'live';
    return [
      m(Button, {
        label: 'Open in Perfetto',
        icon: 'external',
        intent: 'primary',
        compact: true,
        disabled: !live,
        href: live ? child.perfettoUrl : undefined,
        target: '_blank',
      }),
      m(Button, {
        label: live ? 'Stop' : 'Cancel',
        icon: 'stop',
        intent: 'danger',
        variant: 'outlined',
        compact: true,
        loading: pending,
        onclick: () => void store.stop(child.key),
      }),
    ];
  }
}

export class RunningPanel implements m.ClassComponent {
  view(): m.Children {
    const running = store.state?.running ?? [];
    const active = running.filter((c) => c.status !== 'crashed');

    return m('section.tl-panel', [
      m('.tl-panel__head', [
        m('.tl-panel__title', [
          m('span', 'Running'),
          m('span.tl-badge', String(running.length)),
        ]),
        active.length > 0
          ? m(Button, {
              label: 'Stop all',
              icon: 'stop',
              intent: 'danger',
              variant: 'minimal',
              compact: true,
              onclick: () => void store.stopAll(),
            })
          : null,
      ]),
      running.length === 0
        ? m('.tl-empty', [
            m(Icon, {icon: 'play', size: 26, className: 'tl-empty__icon'}),
            m('p.tl-empty__title', 'Nothing running yet'),
            m(
              'p.tl-empty__hint',
              'Start a trace processor from the catalog below.',
            ),
          ])
        : m(
            '.tl-child-grid',
            running.map((child) =>
              m(ChildCard, {key: child.key, child}),
            ),
          ),
    ]);
  }
}
