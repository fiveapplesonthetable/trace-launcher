import m from 'mithril';
import {classNames} from '../base/classnames';
import {Icon, type IconName} from './icon';
import {Spinner} from './spinner';

// The one button widget. Renders a <button>, or an <a> when `href` is set (used
// for "open in Perfetto"). `loading` swaps the icon for a spinner and makes the
// button inert, which is how every in-flight action shows progress on its
// trigger.

export type ButtonIntent = 'neutral' | 'primary' | 'success' | 'danger';
export type ButtonVariant = 'filled' | 'outlined' | 'minimal';

export interface ButtonAttrs {
  readonly label?: string;
  readonly icon?: IconName;
  readonly rightIcon?: IconName;
  readonly intent?: ButtonIntent;
  readonly variant?: ButtonVariant;
  readonly compact?: boolean;
  readonly loading?: boolean;
  readonly disabled?: boolean;
  /** Renders the button as permanently pressed (e.g. an open dropdown). */
  readonly active?: boolean;
  readonly title?: string;
  /** When set, the button renders as an <a> instead of a <button>. */
  readonly href?: string;
  readonly target?: string;
  readonly className?: string;
  readonly onclick?: (e: MouseEvent) => void;
}

export class Button implements m.ClassComponent<ButtonAttrs> {
  view({attrs}: m.CVnode<ButtonAttrs>): m.Children {
    const {
      label,
      icon,
      rightIcon,
      intent = 'neutral',
      variant = 'filled',
      compact = false,
      loading = false,
      disabled = false,
      active = false,
      title,
      href,
      target,
      className,
      onclick,
    } = attrs;

    const inert = disabled || loading;
    const iconSize = compact ? 14 : 16;
    const classes = classNames(
      'tl-button',
      `tl-button--${variant}`,
      `tl-button--${intent}`,
      compact && 'tl-button--compact',
      active && 'tl-button--active',
      inert && 'tl-button--inert',
      icon !== undefined && label === undefined && 'tl-button--icon-only',
      className,
    );

    const body: m.Children = [
      loading
        ? m(Spinner, {size: compact ? 12 : 14})
        : icon !== undefined
          ? m(Icon, {icon, size: iconSize})
          : null,
      label !== undefined ? m('span.tl-button__label', label) : null,
      rightIcon !== undefined ? m(Icon, {icon: rightIcon, size: iconSize}) : null,
    ];

    if (href !== undefined && !inert) {
      return m(
        'a.tl-button-link',
        {
          class: classes,
          href,
          target,
          rel: target === '_blank' ? 'noopener noreferrer' : undefined,
          title,
        },
        body,
      );
    }
    return m(
      'button',
      {
        class: classes,
        type: 'button',
        disabled: inert,
        title,
        onclick: inert ? undefined : onclick,
      },
      body,
    );
  }
}
