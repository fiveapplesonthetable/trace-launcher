import m from 'mithril';
import {App} from './components/app';
import {store} from './core/store';
import './styles/theme.scss';
import './styles/app.scss';

// Entry point: mount the app, then kick off the first state fetch.

const root = document.getElementById('app');
if (root === null) {
  throw new Error('#app mount point is missing from index.html');
}

m.mount(root, App);
store.start();
