import m from 'mithril';

// A compact labelled checkbox used by the column picker. Renders a real
// <input type=checkbox> for accessibility and keyboard support.

export interface CheckboxAttrs {
  readonly label: string;
  readonly checked: boolean;
  readonly onchange: (checked: boolean) => void;
  readonly disabled?: boolean;
}

export class Checkbox implements m.ClassComponent<CheckboxAttrs> {
  view({attrs}: m.CVnode<CheckboxAttrs>): m.Children {
    const {label, checked, onchange, disabled = false} = attrs;
    return m(
      'label.tl-checkbox',
      {class: disabled ? 'tl-checkbox--disabled' : undefined},
      m('input.tl-checkbox__input', {
        type: 'checkbox',
        checked,
        disabled,
        onchange: (e: Event) => {
          onchange((e.target as HTMLInputElement).checked);
        },
      }),
      m('span.tl-checkbox__box'),
      m('span.tl-checkbox__label', label),
    );
  }
}
