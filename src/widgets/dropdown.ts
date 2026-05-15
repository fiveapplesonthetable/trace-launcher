import m from 'mithril';
import {classNames} from '../base/classnames';
import {Button} from './button';
import type {IconName} from './icon';

// A button that toggles an anchored panel — the host for the column picker and
// the filter editor. Closes on a click outside (via a transparent backdrop) or
// the Escape key. State is local to the instance, so two dropdowns never fight.

export interface DropdownAttrs {
  readonly label: string;
  readonly icon?: IconName;
  /** Optional count shown on the trigger, e.g. number of active filters. */
  readonly badge?: number;
  /** Which edge of the trigger the panel aligns to. Defaults to 'left'. */
  readonly align?: 'left' | 'right';
  readonly panelClass?: string;
}

export class Dropdown implements m.ClassComponent<DropdownAttrs> {
  private open = false;

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.open) {
      this.setOpen(false);
      m.redraw();
    }
  };

  onremove(): void {
    document.removeEventListener('keydown', this.onKeyDown);
  }

  view({attrs, children}: m.CVnode<DropdownAttrs>): m.Children {
    const badge = attrs.badge ?? 0;
    return m('.pf-tl-dropdown', [
      m(Button, {
        label: badge > 0 ? `${attrs.label} · ${badge}` : attrs.label,
        icon: attrs.icon,
        rightIcon: 'chevronDown',
        variant: 'outlined',
        compact: true,
        active: this.open,
        onclick: () => this.setOpen(!this.open),
      }),
      this.open
        ? [
            m('.pf-tl-dropdown__backdrop', {onclick: () => this.setOpen(false)}),
            m(
              '.pf-tl-dropdown__panel',
              {
                class: classNames(
                  attrs.align === 'right' && 'pf-tl-dropdown__panel--right',
                  attrs.panelClass,
                ),
              },
              children,
            ),
          ]
        : null,
    ]);
  }

  private setOpen(open: boolean): void {
    this.open = open;
    if (open) {
      document.addEventListener('keydown', this.onKeyDown);
    } else {
      document.removeEventListener('keydown', this.onKeyDown);
    }
  }
}
