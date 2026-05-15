import m from 'mithril';
import type {RunningChild} from '../../shared/types';
import {store} from '../core/store';
import {formatDuration, formatRelativeTime, formatSize} from '../base/format';
import {Button} from '../widgets/button';
import {Icon} from '../widgets/icon';
import {MiddleEllipsis} from '../widgets/middle_ellipsis';
import {ProgressBar} from '../widgets/progress_bar';

// The "Running" panel: one dense row per trace_processor child, including any
// that crashed (so a failed start is never silent). Designed to take a single
// line of vertical space per child — useful information without filling the
// screen. A busy row shows an inline indeterminate progress bar.

/** How long a child may sit in 'starting' before we flag it as slow. */
const SLOW_START_MS = 8000;

interface MetricProps {
  readonly label: string;
  readonly value: string;
}

class Metric implements m.ClassComponent<MetricProps> {
  view({attrs}: m.CVnode<MetricProps>): m.Children {
    return m('span.tl-rrow-metric', [m('em', attrs.label), attrs.value]);
  }
}

class ChildRow implements m.ClassComponent<{child: RunningChild}> {
  view({attrs}: m.CVnode<{child: RunningChild}>): m.Children {
    const {child} = attrs;
    const pending = store.isPending(child.key);
    const busy = pending || child.status === 'starting';

    return m(`.tl-rrow.tl-rrow--${child.status}`, [
      m('.tl-rrow__actions', this.actions(child, pending)),
      m(`span.tl-dot.tl-dot--${child.status}`),
      m(MiddleEllipsis, {
        text: child.name,
        endChars: 14,
        className: 'tl-rrow__name',
      }),
      child.status !== 'crashed'
        ? m('code.tl-chip', `:${child.port}`)
        : null,
      m('.tl-rrow__metrics', this.metrics(child)),
      busy ? m(ProgressBar, {className: 'tl-rrow__progress'}) : null,
    ]);
  }

  private metrics(child: RunningChild): m.Children {
    if (child.status === 'crashed') {
      const exit = child.exit;
      const detail =
        exit !== undefined && exit.signal !== null
          ? `signal ${exit.signal}`
          : exit !== undefined && exit.code !== null && exit.code !== 0
            ? `code ${exit.code}`
            : 'exit 0';
      return [
        m(Metric, {label: 'pid', value: String(child.pid)}),
        m(Metric, {
          label: 'exited',
          value: formatRelativeTime(child.exit?.exitedMs ?? 0),
        }),
        m('span.tl-rrow-metric.tl-rrow-metric--bad', detail),
      ];
    }
    const slow =
      child.status === 'starting' &&
      Date.now() - child.startedMs > SLOW_START_MS;
    const ageLabel = slow ? 'slow' : 'age';
    return [
      m(Metric, {label: 'pid', value: String(child.pid)}),
      m(Metric, {
        label: ageLabel,
        value: formatDuration(Date.now() - child.startedMs),
      }),
      m(Metric, {label: 'rss', value: formatSize(child.rssBytes)}),
      m(Metric, {label: 'trace', value: formatSize(child.traceSize)}),
    ];
  }

  private actions(child: RunningChild, pending: boolean): m.Children {
    // Two icon-only buttons per row, sitting in a fixed-width slot on the
    // left so they never shift between rows. Titles give every button an
    // accessible name without changing the visual width.
    if (child.status === 'crashed') {
      return [
        m(Button, {
          icon: 'refresh',
          intent: 'primary',
          variant: 'outlined',
          compact: true,
          title: 'Retry',
          loading: pending,
          onclick: () => void store.open(child.key),
        }),
        m(Button, {
          icon: 'close',
          variant: 'minimal',
          compact: true,
          title: 'Dismiss',
          onclick: () => void store.stop(child.key),
        }),
      ];
    }
    const live = child.status === 'live';
    return [
      m(Button, {
        icon: 'external',
        intent: 'primary',
        variant: 'outlined',
        compact: true,
        title: 'Open in Perfetto',
        disabled: !live,
        href: live ? child.perfettoUrl : undefined,
        target: '_blank',
      }),
      m(Button, {
        icon: 'stop',
        intent: 'danger',
        variant: 'outlined',
        compact: true,
        title: live ? 'Stop' : 'Cancel',
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
        ? m(
            '.tl-rrow-empty',
            m(Icon, {icon: 'play', size: 14}),
            'No trace processors running — start one from the catalog above.',
          )
        : m(
            '.tl-rrow-list',
            running.map((child) =>
              m(ChildRow, {key: child.key, child}),
            ),
          ),
    ]);
  }
}
