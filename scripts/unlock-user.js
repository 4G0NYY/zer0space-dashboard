'use strict';

// Break-glass account unlock.
//
//   docker exec -it <dashboard-container> npm run unlock-user -- <username>
//   docker exec -it <dashboard-container> npm run unlock-user -- --list
//
// Account lockouts expire on their own after 30 minutes (see src/auth.js) and an
// admin can clear one from Settings → Users, so this script is not the normal
// path. It exists for the case those two cannot help: every admin account locked
// at the same time, with /setup already sealed. Without it the only way back in
// would be hand-written SQL against the production database.
//
// It deliberately CANNOT create an account or change a password. Locking is the
// only thing it touches, so possessing it is not equivalent to possessing the
// dashboard.

const db = require('../src/db');

async function main() {
  const arg = process.argv[2];

  if (!arg || arg === '--help' || arg === '-h') {
    console.log('usage: npm run unlock-user -- <username>');
    console.log('       npm run unlock-user -- --list      # show locked accounts');
    process.exit(arg ? 0 : 1);
  }

  const reachable = await db.waitForDb({ attempts: 3, delayMs: 1500 });
  if (!reachable) {
    console.error('[unlock] cannot reach PostgreSQL — check DB_HOST/DB_PORT and the db_password secret');
    process.exit(2);
  }

  if (arg === '--list') {
    const rows = await db.all(
      `SELECT username, role, failed_attempts, locked_until
         FROM users
        WHERE locked_until > NOW()
        ORDER BY username`
    );
    if (!rows.length) {
      console.log('[unlock] no accounts are currently locked');
    } else {
      console.log(`[unlock] ${rows.length} locked account(s):`);
      for (const r of rows) {
        const mins = Math.ceil((new Date(r.locked_until).getTime() - Date.now()) / 60_000);
        console.log(`  ${r.username} (${r.role}) — ${r.failed_attempts} failed, unlocks in ${mins} min`);
      }
    }
    return;
  }

  const { rowCount } = await db.query(
    'UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE username = $1',
    [arg]
  );

  if (!rowCount) {
    console.error(`[unlock] no such user: ${arg}`);
    process.exit(3);
  }
  console.log(`[unlock] '${arg}' unlocked — failed attempt counter reset`);
}

main()
  .then(() => db.pool.end())
  .catch(async (err) => {
    console.error(`[unlock] failed: ${err.message}`);
    try { await db.pool.end(); } catch { /* already closing */ }
    process.exit(1);
  });
