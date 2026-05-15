import m from 'mithril';
import {store} from '../core/store';
import {Button} from '../widgets/button';
import {Icon} from '../widgets/icon';
import {MiddleEllipsis} from '../widgets/middle_ellipsis';

// The sticky application header: brand on the left, the traces directory and
// global controls (theme, manual refresh) on the right.

export class TopBar implements m.ClassComponent {
  view(): m.Children {
    const config = store.state?.config;
    const darkActive = store.theme === 'dark';
    return m('header.tl-topbar', [
      m('.tl-topbar__brand', [
        m('.tl-logo', m(Icon, {icon: 'file', size: 18})),
        m('.tl-topbar__titles', [
          m('h1.tl-topbar__title', 'Trace Launcher'),
          m('span.tl-topbar__subtitle', 'trace_processor UI launcher'),
        ]),
      ]),
      m('.tl-topbar__meta', [
        config !== undefined
          ? m('.tl-topbar__dir', {title: config.tracesDir}, [
              m(Icon, {icon: 'folder', size: 13}),
              m(MiddleEllipsis, {text: config.tracesDir, endChars: 18}),
            ])
          : null,
        m(Button, {
          variant: 'minimal',
          icon: darkActive ? 'sun' : 'moon',
          title: darkActive ? 'Switch to light theme' : 'Switch to dark theme',
          onclick: () => store.toggleTheme(),
        }),
        m(Button, {
          variant: 'minimal',
          icon: 'refresh',
          title: 'Refresh now',
          loading: store.initialLoad,
          onclick: () => void store.refresh(),
        }),
      ]),
    ]);
  }
}
