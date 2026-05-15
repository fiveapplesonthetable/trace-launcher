import m from 'mithril';
import {classNames} from '../base/classnames';

// A small indeterminate spinner. Sized in pixels so it can sit inline next to
// text of any size (e.g. inside a button).

export interface SpinnerAttrs {
  readonly size?: number;
  readonly className?: string;
}

export class Spinner implements m.ClassComponent<SpinnerAttrs> {
  view({attrs}: m.CVnode<SpinnerAttrs>): m.Children {
    const size = attrs.size ?? 14;
    return m('span.tl-spinner', {
      class: classNames(attrs.className),
      style: {width: `${size}px`, height: `${size}px`},
    });
  }
}
