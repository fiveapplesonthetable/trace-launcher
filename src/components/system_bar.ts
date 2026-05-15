import m from 'mithril';
import {store} from '../core/store';
import {formatSize, formatUsage, usagePercent} from '../base/format';
import {Icon, type IconName} from '../widgets/icon';
import {ProgressBar} from '../widgets/progress_bar';

// A row of compact stat cards: host memory, disk, and a roll-up of the running
// trace processors. Everything here is glanceable — no interaction.

interface StatCardAttrs {
  readonly icon: IconName;
  readonly label: string;
  readonly value: string;
  readonly meter?: number;
  readonly hint?: string;
}

class StatCard implements m.ClassComponent<StatCardAttrs> {
  view({attrs}: m.CVnode<StatCardAttrs>): m.Children {
    return m('.pf-tl-stat', [
      m('.pf-tl-stat__head', [
        m(Icon, {icon: attrs.icon, size: 15}),
        m('span.pf-tl-stat__label', attrs.label),
      ]),
      m('.pf-tl-stat__value', attrs.value),
      attrs.meter !== undefined ? m(ProgressBar, {value: attrs.meter}) : null,
      attrs.hint !== undefined ? m('.pf-tl-stat__hint', attrs.hint) : null,
    ]);
  }
}

export class SystemBar implements m.ClassComponent {
  view(): m.Children {
    const state = store.state;
    if (state === null) return null;
    const {memory, disk} = state.system;
    const running = state.running;
    const active = running.filter((c) => c.status !== 'crashed');
    const crashed = running.length - active.length;
    const totalRss = active.reduce((sum, c) => sum + c.rssBytes, 0);

    return m('.pf-tl-systembar', [
      m(StatCard, {
        icon: 'memory',
        label: 'Host memory',
        value: formatUsage(memory.used, memory.total),
        meter: usagePercent(memory.used, memory.total),
      }),
      m(StatCard, {
        icon: 'disk',
        label: 'Disk',
        value: formatUsage(disk.used, disk.total),
        meter: usagePercent(disk.used, disk.total),
        hint: disk.path,
      }),
      m(StatCard, {
        icon: 'bolt',
        label: 'Memory usage',
        value:
          active.length === 0
            ? 'none running'
            : `${active.length} running · ${formatSize(totalRss)} RSS`,
        hint:
          crashed > 0
            ? `${crashed} crashed — needs attention`
            : undefined,
      }),
    ]);
  }
}
