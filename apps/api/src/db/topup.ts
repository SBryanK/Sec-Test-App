/**
 * Grant credits to the seed operator.
 *
 * A development and test utility. The integration suite executes real runs, and
 * runs are charged, so a long session of test iterations will legitimately
 * exhaust the seeded balance. Rather than weakening credit enforcement for
 * everyone, this tops the test account up on demand.
 *
 *   npm run credits:topup -- 500
 */

import { config } from '../config.ts';
import { closePool, query } from './pool.ts';

async function main(): Promise<void> {
  const amount = Number(process.argv[2] ?? 500);
  if (!Number.isFinite(amount) || amount <= 0) {
    console.error('Usage: npm run credits:topup -- <amount>');
    process.exit(1);
  }

  const { rows } = await query<{ id: string; email: string }>(
    `SELECT id, email FROM users WHERE lower(email) = lower($1)`,
    [config.seedUser.email],
  );
  const user = rows[0];
  if (!user) {
    console.error(`No account found for ${config.seedUser.email} — run db:migrate first.`);
    process.exit(1);
  }

  await query(`INSERT INTO credit_ledger (user_id, delta, reason) VALUES ($1, $2, 'topup')`, [
    user.id,
    amount,
  ]);

  const balance = await query<{ used: string }>(
    `SELECT COALESCE(-SUM(delta), 0)::text AS used FROM credit_ledger WHERE user_id = $1 AND delta < 0`,
    [user.id],
  );

  console.log(`[credits] granted ${amount} to ${user.email} (${balance.rows[0]?.used ?? 0} used so far)`);
}

main()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    console.error('[credits] failed:', err);
    await closePool().catch(() => undefined);
    process.exit(1);
  });
