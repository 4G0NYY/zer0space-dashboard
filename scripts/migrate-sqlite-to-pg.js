#!/usr/bin/env node
'use strict';

// One-off migration: copies the dashboard's SQLite database into PostgreSQL.
//
//   node scripts/migrate-sqlite-to-pg.js --sqlite /pfad/services.db
//   node scripts/migrate-sqlite-to-pg.js --sqlite ./services.db --dry-run
//
// Target DB comes from the same env vars the server uses (DATABASE_URL, or
// DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASS) — no credentials in this file.
//
// Properties:
//   * Preserves primary keys, so vault_entries.user_id keeps pointing at the right user.
//   * Resets the SERIAL sequences afterwards — without that the next INSERT would
//     start at 1 and collide with the migrated rows.
//   * Re-runnable: existing rows (same id / same key) are skipped, not duplicated.
//   * Vault ciphertext is copied verbatim. The encryption is unchanged by the move,
//     so entries stay decryptable with the users' existing passwords.
//
// better-sqlite3 is a devDependency (the runtime image installs with --omit=dev and
// therefore no longer needs python3/make/g++). Run this from a checkout with
// `npm install` — not from inside the production container.

const path = require('path');

function parseArgs(argv) {
  const args = { sqlite: null, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sqlite') args.sqlite = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else {
      console.error(`Unbekanntes Argument: ${a}`);
      args.help = true;
    }
  }
  return args;
}

function usage() {
  console.log(`
Migrates the dashboard SQLite DB to PostgreSQL.

  node scripts/migrate-sqlite-to-pg.js --sqlite <path/services.db> [--dry-run]

Options:
  --sqlite <path>   Path to the old services.db (required)
  --dry-run         Only count and report, write nothing

Target DB via environment variables (same as the server):
  DATABASE_URL                                  or
  DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASS
`);
}

// SQLite tables/columns as they existed before the migration.
const TABLES = [
  {
    name: 'users',
    columns: ['id', 'username', 'hash', 'role', 'theme', 'vault_salt'],
    // ON CONFLICT on both keys: id (PK) and username (UNIQUE).
    conflict: '(id) DO NOTHING',
    sequence: 'users_id_seq',
  },
  {
    name: 'services',
    columns: ['id', 'name', 'description', 'url', 'icon', 'status'],
    conflict: '(id) DO NOTHING',
    sequence: 'services_id_seq',
  },
  {
    name: 'settings',
    // DO UPDATE, not DO NOTHING: initSchema() seeds settings.theme='cyan' before the
    // copy runs, so DO NOTHING would silently discard the user's real theme (and any
    // other setting that happens to be pre-seeded). For a migration the SQLite value
    // is the source of truth and must win.
    conflict: '(key) DO UPDATE SET value = EXCLUDED.value',
    columns: ['key', 'value'],
    sequence: null,
  },
  {
    name: 'vault_entries',
    columns: ['id', 'user_id', 'title', 'username', 'encrypted_password',
              'encrypted_notes', 'url', 'created_at', 'updated_at'],
    conflict: '(id) DO NOTHING',
    sequence: 'vault_entries_id_seq',
  },
];

function readSqliteTable(sdb, table) {
  // Only select columns that actually exist — older DBs may predate vault_salt.
  const present = new Set(sdb.prepare(`PRAGMA table_info(${table.name})`).all().map(c => c.name));
  const cols = table.columns.filter(c => present.has(c));
  if (cols.length === 0) return { cols: [], rows: [] };
  const rows = sdb.prepare(`SELECT ${cols.join(', ')} FROM ${table.name}`).all();
  return { cols, rows };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.sqlite) {
    usage();
    process.exit(args.sqlite ? 0 : 1);
  }

  const sqlitePath = path.resolve(args.sqlite);

  let Database;
  try {
    Database = require('better-sqlite3');
  } catch {
    console.error(
      'better-sqlite3 is not installed. It is a devDependency —\n' +
      'run "npm install" once in the project directory and start again.'
    );
    process.exit(1);
  }

  const db = require('../src/db');

  console.log(`[migrate] Source : ${sqlitePath}`);
  console.log(`[migrate] Target : ${db.describeTarget()}`);
  if (args.dryRun) console.log('[migrate] DRY RUN — nothing will be written');

  let sdb;
  try {
    sdb = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  } catch (err) {
    console.error(`[migrate] SQLite DB not readable: ${err.message}`);
    process.exit(1);
  }

  // Fail early with a clear message rather than halfway through.
  const reachable = await db.waitForDb({ attempts: 3, delayMs: 2000 });
  if (!reachable) {
    console.error('[migrate] PostgreSQL unreachable — aborting, nothing was written.');
    process.exit(1);
  }
  await db.initSchema();
  console.log('[migrate] Schema ensured in PostgreSQL');

  const summary = [];

  // vault_entries.user_id is a real foreign key in PostgreSQL (it was not one in
  // SQLite). An orphaned entry would abort the whole transaction with a cryptic
  // constraint error, so find those first and report them by name.
  let orphanIds = new Set();
  try {
    const userIds = new Set(sdb.prepare('SELECT id FROM users').all().map(r => r.id));
    const orphans = sdb.prepare('SELECT id, user_id, title FROM vault_entries').all()
      .filter(r => !userIds.has(r.user_id));
    if (orphans.length) {
      orphanIds = new Set(orphans.map(o => o.id));
      console.warn(
        `\n[migrate] WARNING: ${orphans.length} vault entry/entries reference a user that ` +
        `no longer exists and will be SKIPPED:`
      );
      for (const o of orphans) console.warn(`           id=${o.id} user_id=${o.user_id} "${o.title}"`);
      console.warn(
        '           (These entries would not be decryptable anyway — the owning user,\n' +
        '            and therefore their key, no longer exists.)\n'
      );
    }
  } catch { /* tables may not exist in a very old DB — handled per-table below */ }

  try {
    await db.tx(async (client) => {
      for (const table of TABLES) {
        const { cols, rows } = readSqliteTable(sdb, table);
        if (cols.length === 0) {
          console.log(`[migrate] ${table.name}: table/columns missing in the SQLite DB — skipped`);
          summary.push({ table: table.name, read: 0, inserted: 0, skipped: 0 });
          continue;
        }

        let inserted = 0;
        let orphansSkipped = 0;
        for (const row of rows) {
          if (table.name === 'vault_entries' && orphanIds.has(row.id)) { orphansSkipped++; continue; }
          const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
          const values = cols.map(c => row[c]);
          if (args.dryRun) continue;
          const res = await client.query(
            `INSERT INTO ${table.name} (${cols.join(', ')})
             VALUES (${placeholders})
             ON CONFLICT ${table.conflict}`,
            values
          );
          inserted += res.rowCount;
        }

        const skipped = args.dryRun ? 0 : rows.length - inserted - orphansSkipped;
        summary.push({ table: table.name, read: rows.length, inserted, skipped, orphansSkipped });
        console.log(
          `[migrate] ${table.name}: ${rows.length} read, ` +
          `${args.dryRun ? '(dry-run)' : `${inserted} inserted, ${skipped} already present`}` +
          `${orphansSkipped ? `, ${orphansSkipped} orphaned skipped` : ''}`
        );
      }

      if (args.dryRun) {
        // Roll the whole thing back — tx() commits otherwise.
        throw Object.assign(new Error('__DRY_RUN__'), { dryRun: true });
      }

      // Sequences must follow the highest migrated id, otherwise the next INSERT
      // starts at 1 and hits a duplicate-key error on the migrated rows.
      for (const table of TABLES) {
        if (!table.sequence) continue;
        await client.query(
          `SELECT setval(
             pg_get_serial_sequence($1, 'id'),
             GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${table.name}), 1),
             (SELECT COUNT(*) FROM ${table.name}) > 0
           )`,
          [table.name]
        );
      }
      console.log('[migrate] Sequences set to the highest migrated value');
    });
  } catch (err) {
    if (err.dryRun) {
      console.log('[migrate] DRY RUN finished — transaction rolled back, nothing written.');
      await db.pool.end();
      sdb.close();
      process.exit(0);
    }
    console.error(`[migrate] ERROR — transaction rolled back, nothing was written: ${err.message}`);
    await db.pool.end();
    sdb.close();
    process.exit(1);
  }

  // Post-migration sanity check: compare row counts.
  console.log('\n[migrate] Verification (rows in PostgreSQL):');
  for (const table of TABLES) {
    const { c } = await db.one(`SELECT COUNT(*)::int AS c FROM ${table.name}`);
    const s = summary.find(x => x.table === table.name);
    console.log(`  ${table.name.padEnd(15)} PostgreSQL: ${String(c).padStart(5)}   SQLite read: ${String(s?.read ?? 0).padStart(5)}`);
  }

  console.log(`
[migrate] Done.

Next steps:
  1. Redeploy the dashboard with the DB_* variables set and sign in.
  2. Check: are services, users, theme and vault entries all visible?
  3. Do NOT delete the old services.db yet — only after a successful check,
     it is the only rollback you have.
`);

  await db.pool.end();
  sdb.close();
}

main().catch((err) => {
  console.error(`[migrate] Unexpected error: ${err.stack || err.message}`);
  process.exit(1);
});
