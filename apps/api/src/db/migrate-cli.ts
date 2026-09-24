/**
 * CLI entry point for applying the database schema.
 *
 * This lives in its own file on purpose. When the CLI runner sat in migrate.ts
 * behind an `import.meta.url === process.argv[1]` guard, bundling for production
 * made that guard evaluate true — the server would run the migration, exit 0,
 * and never serve a request. A library module must not carry a side-effecting
 * main block that a bundler can reach.
 *
 *   npm run db:migrate
 */

import { migrate } from './migrate.ts';
import { closePool } from './pool.ts';

migrate()
  .then(async () => {
    console.log('[db] schema applied and seed account ensured');
    await closePool();
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    console.error('[db] migration failed:', err);
    await closePool().catch(() => undefined);
    process.exit(1);
  });
