import m from 'mithril';
import {classNames} from '../base/classnames';

// A thin progress bar with two modes:
//  - determinate: pass `value` (0-100), e.g. host memory usage;
//  - indeterminate: omit `value` for a looping animation, used inline while a
//    start/stop action is in flight.

export type ProgressIntent = 'normal' | 'warn' | 'danger';

export interface ProgressBarAttrs {
  readonly value?: number;
  readonly intent?: ProgressIntent;
  readonly className?: string;
}

export class ProgressBar implements m.ClassComponent<ProgressBarAttrs> {
  view({attrs}: m.CVnode<ProgressBarAttrs>): m.Children {
    const indeterminate = attrs.value === undefined;
    const value = clamp(attrs.value ?? 0, 0, 100);
    const intent: ProgressIntent =
      attrs.intent ?? (value >= 90 ? 'danger' : value >= 75 ? 'warn' : 'normal');
    return m(
      '.tl-progress',
      {
        class: classNames(
          indeterminate && 'tl-progress--indeterminate',
          attrs.className,
        ),
      },
      m(`.tl-progress__fill.tl-progress__fill--${intent}`, {
        style: indeterminate ? undefined : {width: `${value}%`},
      }),
    );
  }
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}
