// Builds fixtures/metadata.db — a small SQLite database of trace metadata used
// by `npm run dev` and the e2e tests to exercise the metadata column / filter
// / suggestion features. Re-run with: node fixtures/make-metadata-db.mjs
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(here, 'metadata.db');
fs.rmSync(dbPath, {force: true});

const db = new Database(dbPath);
db.exec(`
  CREATE TABLE traces (
    path             TEXT NOT NULL,
    device           TEXT,
    android_version  INTEGER,
    duration_ms      INTEGER,
    captured_by      TEXT
  );
`);

const insert = db.prepare(
  `INSERT INTO traces (path, device, android_version, duration_ms, captured_by)
   VALUES (@path, @device, @android_version, @duration_ms, @captured_by)`,
);

const rows = [
  ['android-boot.pftrace', 'pixel-8-pro', 14, 32000, 'ci-bot'],
  ['chrome-startup.perfetto-trace', 'pixel-9', 15, 8400, 'aria'],
  ['scheduler.trace', 'pixel-6a', 13, 1200, 'ci-bot'],
  ['game-frame.pftrace', 'pixel-9-pro', 15, 16500, 'devon'],
  ['jank-investigation.perfetto-trace.gz', 'pixel-7', 14, 24800, 'aria'],
  ['broken-crash.pftrace', 'pixel-8', 14, 5000, 'ci-bot'],
  ['slow-hang.pftrace', 'pixel-9', 15, 60000, 'devon'],
];
for (const [p, device, ver, dur, by] of rows) {
  insert.run({
    path: p,
    device,
    android_version: ver,
    duration_ms: dur,
    captured_by: by,
  });
}

db.close();
console.log(`wrote ${dbPath} (${rows.length} rows)`);
