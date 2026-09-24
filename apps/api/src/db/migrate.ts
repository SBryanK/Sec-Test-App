import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../config.ts';
import { pool, query } from './pool.ts';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the migrations directory.
 *
 * The module sits at `src/db/migrate.ts` under tsx, but the production bundle
 * flattens it into `dist/index.js`. Rather than depend on one layout, try the
 * known positions.
 */
async function migrationsDir(): Promise<string> {
  const candidates = [
    join(here, 'migrations'), // src/db/migrations
    join(here, 'db', 'migrations'), // dist/db/migrations
    join(here, '..', 'db', 'migrations'),
  ];
  for (const candidate of candidates) {
    try {
      const entries = await readdir(candidate);
      if (entries.some((e) => e.endsWith('.sql'))) return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(
    `Could not locate the migrations directory. Looked in:\n  ${candidates.join('\n  ')}`,
  );
}

/**
 * Apply pending migrations, then seed the default account.
 *
 * Migrations are numbered SQL files applied once each and recorded in
 * `schema_migrations`. The previous approach — running a single idempotent
 * `schema.sql` on every boot — could never apply a *change*: adding a column
 * later would silently do nothing on an existing database, which is the kind of
 * bug that only shows up months into production.
 *
 * Each migration runs inside a transaction, so a failure leaves the database at
 * the last good version rather than half-migrated.
 */
export async function migrate(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const dir = await migrationsDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  const { rows } = await query<{ version: string }>(`SELECT version FROM schema_migrations`);
  const applied = new Set(rows.map((r) => r.version));

  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) {
    await seed();
    return;
  }

  for (const file of pending) {
    const sql = await readFile(join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [file]);
      await client.query('COMMIT');
      console.log(`[db] applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(
        `Migration ${file} failed and was rolled back: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      client.release();
    }
  }

  await seed();
}

async function seed(): Promise<void> {
  const { id, email, displayName, password, role, creditsTotal } = config.seedUser;

  // Password hashing stays dependency-free: scrypt via node:crypto.
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64).toString('hex');
  const passwordHash = `scrypt$${salt}$${derived}`;

  await query(
    `INSERT INTO users (id, email, display_name, password_hash, role, credits_total)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (email) DO NOTHING`,
    [id, email, displayName, passwordHash, role, creditsTotal],
  );
}

/** Verify a password against its stored scrypt hash. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = parts[1] ?? '';
  const expected = parts[2] ?? '';
  const derived = scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(derived, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
