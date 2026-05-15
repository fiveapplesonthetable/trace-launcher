import m from 'mithril';
import {classNames} from '../base/classnames';

// Truncates long text in the *middle* rather than the end, so the most
// identifying parts of a path or trace name — usually the start and the
// extension — both stay visible. The tail is pinned and the head ellipsises.
// The full string is always available as a tooltip.

export interface MiddleEllipsisAttrs {
  readonly text: string;
  /** Trailing characters to keep pinned (default 12). */
  readonly endChars?: number;
  readonly className?: string;
}

export class MiddleEllipsis implements m.ClassComponent<MiddleEllipsisAttrs> {
  view({attrs}: m.CVnode<MiddleEllipsisAttrs>): m.Children {
    const {text} = attrs;
    const endChars = attrs.endChars ?? 12;
    // Never pin more than a third of the string, so short text isn't all-tail.
    const keep = Math.min(endChars, Math.floor(text.length / 3));
    const head = text.slice(0, text.length - keep);
    const tail = text.slice(text.length - keep);
    return m(
      '.tl-mid-ellipsis',
      {class: classNames(attrs.className), title: text},
      m('span.tl-mid-ellipsis__head', head),
      tail !== '' ? m('span.tl-mid-ellipsis__tail', tail) : null,
    );
  }
}
