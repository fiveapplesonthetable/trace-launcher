import m from 'mithril';

// Inline SVG icons (Material-style 24x24 paths) so the app ships with zero
// font or network dependencies. Icon names are a closed union, so a typo is a
// compile error rather than a blank square.

const PATHS = {
  play: 'M8 5v14l11-7z',
  stop: 'M6 6h12v12H6z',
  folder:
    'M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm4 18H6V4h7v5h5v11z',
  search:
    'M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z',
  refresh:
    'M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
  external:
    'M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7zM19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7z',
  memory:
    'M15 9H9v6h6V9zm4 6h2v-2h-2v-2h2V9h-2V7a2 2 0 0 0-2-2h-2V3h-2v2h-2V3H9v2H7a2 2 0 0 0-2 2v2H3v2h2v2H3v2h2v2a2 2 0 0 0 2 2h2v2h2v-2h2v2h2v-2h2a2 2 0 0 0 2-2v-2zm-4 2H7V7h10v10z',
  disk: 'M12 2C6.49 2 2 4.02 2 6.5v11C2 19.98 6.49 22 12 22s10-2.02 10-4.5v-11C22 4.02 17.51 2 12 2zm0 2c4.5 0 8 1.62 8 2.5S16.5 9 12 9 4 7.38 4 6.5 7.5 4 12 4zm8 13.5c0 .88-3.5 2.5-8 2.5s-8-1.62-8-2.5v-2.95C5.81 15.46 8.69 16 12 16s6.19-.54 8-1.45v2.95zm0-5c0 .88-3.5 2.5-8 2.5s-8-1.62-8-2.5V9.55C5.81 10.46 8.69 11 12 11s6.19-.54 8-1.45v2.95z',
  sun: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 8a3 3 0 1 1 0-6 3 3 0 0 1 0 6zM2 13h2a1 1 0 0 0 0-2H2a1 1 0 0 0 0 2zm18 0h2a1 1 0 0 0 0-2h-2a1 1 0 0 0 0 2zM11 2v2a1 1 0 0 0 2 0V2a1 1 0 0 0-2 0zm0 18v2a1 1 0 0 0 2 0v-2a1 1 0 0 0-2 0zM5.99 4.58a1 1 0 0 0-1.41 1.41l1.06 1.06a1 1 0 0 0 1.41-1.41L5.99 4.58zm12.37 12.37a1 1 0 0 0-1.41 1.41l1.06 1.06a1 1 0 0 0 1.41-1.41l-1.06-1.06zm1.06-10.96a1 1 0 0 0-1.41-1.41l-1.06 1.06a1 1 0 0 0 1.41 1.41l1.06-1.06zM7.05 18.36a1 1 0 0 0-1.41-1.41l-1.06 1.06a1 1 0 0 0 1.41 1.41l1.06-1.06z',
  moon: 'M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.4 5.4 0 0 1-5.4-5.4c0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z',
  home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
  chevronRight:
    'M9.29 6.71a1 1 0 0 0 0 1.41L13.17 12l-3.88 3.88a1 1 0 1 0 1.42 1.41l4.59-4.59a1 1 0 0 0 0-1.41L10.71 6.7a1 1 0 0 0-1.42 0z',
  chevronDown:
    'M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z',
  alert: 'M12 2 1 21h22L12 2zm1 14h-2v2h2v-2zm0-6h-2v4h2v-4z',
  close:
    'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  filter: 'M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z',
  columns:
    'M14.67 5v14H9.33V5h5.34zm1 14H21V5h-5.33v14zm-7.34 0V5H3v14h5.33z',
  check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z',
  arrowUp: 'M7 14l5-5 5 5z',
  arrowDown: 'M7 10l5 5 5-5z',
  plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
} as const;

export type IconName = keyof typeof PATHS;

export interface IconAttrs {
  readonly icon: IconName;
  readonly size?: number;
  readonly className?: string;
}

export class Icon implements m.ClassComponent<IconAttrs> {
  view({attrs}: m.CVnode<IconAttrs>): m.Children {
    const size = attrs.size ?? 18;
    return m(
      'svg.tl-icon',
      {
        class: attrs.className,
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'currentColor',
        'aria-hidden': 'true',
      },
      m('path', {d: PATHS[attrs.icon]}),
    );
  }
}
