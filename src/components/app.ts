import m from 'mithril';
import {store} from '../core/store';
import {Icon} from '../widgets/icon';
import {CatalogPanel} from './catalog_panel';
import {SystemBar} from './system_bar';
import {TopBar} from './topbar';

// The application shell: a sticky top bar, the scrollable content (host stats,
// running processors, the catalog), and a footer of static config facts.

class Footer implements m.ClassComponent {
  view(): m.Children {
    const config = store.state?.config;
    if (config === undefined) return null;
    return m('footer.tl-footer', [
      m('span.tl-footer__item', [m('em', 'tp-binary'), config.tpBinary]),
      m('span.tl-footer__item', [
        m('em', 'backend ports'),
        `${config.tpPortRange[0]}–${config.tpPortRange[1]}`,
      ]),
      config.metadataEnabled
        ? m('span.tl-footer__item', [m('em', 'metadata'), 'enabled'])
        : null,
      m('span.tl-footer__spacer'),
      m('span.tl-footer__item', 'auto-refreshing'),
    ]);
  }
}

export class App implements m.ClassComponent {
  view(): m.Children {
    const loading = store.initialLoad && store.state === null;
    return m('.tl-app', [
      m(TopBar),
      m('main.tl-shell', [
        store.error !== null
          ? m('.tl-error', [
              m(Icon, {icon: 'alert', size: 16}),
              m('span', store.error),
            ])
          : null,
        loading
          ? m('.tl-splash', [
              m('span.tl-spinner.tl-spinner--lg'),
              m('p', 'Loading catalog…'),
            ])
          : [m(SystemBar), m(CatalogPanel)],
      ]),
      m(Footer),
    ]);
  }
}
