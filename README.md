# Trace Launcher

A fast, minimal web UI for launching [`trace_processor_shell`][tp] servers from
a directory of Perfetto traces.

Point it at a folder of traces and a `trace_processor_shell` binary. It gives
you a browsable, searchable, filterable catalog; one click starts a
`trace_processor_shell server` for a trace and hands you a deep link straight
into [ui.perfetto.dev][ui]. It tracks every child process — live, still coming
up, or crashed — so you always know what is running and on which port.

It is the spiritual successor to the single-file `serve_trace_ui.py` operator
helper: same job, but a real typed front end and back end instead of
server-rendered HTML.

[tp]: https://perfetto.dev/docs/analysis/trace-processor
[ui]: https://ui.perfetto.dev

## Screenshots

| Catalog | Running processors |
| --- | --- |
| ![Catalog view](docs/screenshot-catalog.png) | ![Running processors](docs/screenshot-running.png) |

| Filtering | Light theme |
| --- | --- |
| ![Filter editor](docs/screenshot-filter.png) | ![Light theme](docs/screenshot-light.png) |

## What it does

- **Browse & search** — walk the trace directory, or search by name (within the
  current directory, or recursively under the root with `--recursive-search`).
- **Launch & track** — start a `trace_processor_shell server` per trace, open it
  in ui.perfetto.dev, and stop it again. Starts are idempotent, so a
  double-click never spawns two servers.
- **Honest status** — every child is shown as `starting`, `live`, or `crashed`
  (with its exit code/signal). A crash is never silent; retry or dismiss it
  inline.
- **Host stats** — host memory and disk usage, plus a roll-up of running
  processors and their total RSS.
- **Configurable columns** — choose which columns the catalog shows: file
  params (path, size, modified) and any column of an optional metadata DB.
- **Structured filters** — filter the catalog on path, size, and metadata
  columns. Metadata filters run as SQL against the metadata database;
  text-column filters offer value autocomplete.
- **Optional metadata DB** — join a SQLite table of per-trace metadata
  (device, duration, owner, …) onto the catalog for display and filtering.
- **Dark / light themes**, fast debounced search, and inline progress on every
  start/stop action.

## Quick start

Requires Node.js ≥ 18.19.

```sh
npm install
npm run build          # bundles the SPA into dist/
npm start -- \
  --tp-binary /path/to/trace_processor_shell \
  --traces-dir /path/to/traces
```

Then open <http://127.0.0.1:9002>.

### Try it with the bundled fixtures

The repo ships a fake `trace_processor_shell`, a handful of sample traces, and a
metadata database, so you can run the whole thing with no real binary:

```sh
npm install
npm run dev            # API + Vite dev server with live reload
```

`npm run dev` serves the UI on <http://localhost:5173> and proxies the API to
the back end on `:9002`. The fixture traces include deliberately
`broken-crash` and `slow-hang` files so you can see how the UI handles a
crashing or stuck `trace_processor_shell`.

## Usage

```
trace-launcher — a fast web UI for launching trace_processor_shell servers

Usage:
  npm start -- --tp-binary <path> --traces-dir <dir> [options]

Required:
  --tp-binary <path>         trace_processor_shell executable
  --traces-dir <dir>         directory of trace files to browse

Options:
  --trace <path>             expose only this trace; repeatable. Relative paths
                             resolve under --traces-dir, disabling browsing.
  --bind <addr>              address for the UI + backend servers (default 127.0.0.1)
  --port <n>                 port for the UI + API (default 9002)
  --tp-port-base <n>         first backend trace_processor port (default 19000)
  --tp-port-count <n>        size of the backend port range (default 4096)
  --max-results <n>          max traces shown per page; 0 = unlimited (default 5000)
  --recursive-search         search recursively under --traces-dir

Metadata (optional — joins a SQLite table to the trace list):
  --metadata-db <path>       SQLite database with a row of metadata per trace
  --metadata-table <name>    table inside --metadata-db to read
  --metadata-key-column <c>  column holding the trace path/name to join on
                             (auto-detected from common names if omitted)
```

### Metadata database

`--metadata-db` points at any SQLite database; `--metadata-table` picks the
table. Each row is joined to a trace by a key column — its value is matched
against the trace's absolute path, its path relative to the root, or its base
name, so a table of bare filenames and a table of absolute paths both work.
The key column is auto-detected from common names (`path`, `trace`, `file`, …)
or set explicitly with `--metadata-key-column`.

Every column of that table becomes available in the catalog: toggle it on from
the **Columns** menu, sort by it, and filter on it. Metadata filters are
compiled to parameterised SQL and run against the database; text columns offer
distinct-value autocomplete in the filter editor.

## Development

```sh
npm run dev          # API + UI with live reload (uses the fixtures)
npm run typecheck    # tsc --noEmit for both the SPA and the server
npm run test         # unit tests (node:test)
npm run build        # production SPA bundle
npm run check        # typecheck + test + build
npm run seed         # rebuild fixtures/metadata.db
```

## Architecture

```
shared/      Wire-protocol types imported by both sides — the single contract.
server/      Node + Express API. No UI logic.
  catalog.ts        lists / searches / filters traces, resolves UI-supplied paths
  process_manager.ts spawns, tracks, and reaps trace_processor_shell children
  metadata.ts       optional SQLite metadata: columns, joins, SQL filters, suggest
  ports.ts          TCP port probing + round-robin allocation
  system.ts         host memory / disk / per-process RSS
  config.ts         CLI parsing and validation
  api.ts            the HTTP routes — a thin layer over the modules above
src/         Mithril + TypeScript SPA.
  core/             API client and the application store (state + poll loop)
  widgets/          reusable building blocks (Button, Dropdown, ProgressBar, …)
  components/        the screen: top bar, system bar, running panel, catalog
  base/             pure, DOM-free helpers (formatting, classnames)
fixtures/    A fake trace_processor_shell, sample traces, and a metadata DB.
```

The browser cannot spawn processes, so a small Node server does it. The SPA
polls `POST /api/state` for a full snapshot (catalog page + running children +
host stats); cadence speeds up automatically while a child is still starting.
Every trace is identified by its absolute real path — the client only ever
echoes back keys the server handed out, and every path is re-validated against
the configured root before use.

## License

Apache-2.0
