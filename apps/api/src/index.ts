import { migrate } from './db/migrate.ts';
import { start } from './server.ts';

async function main(): Promise<void> {
  console.log('[api] applying database schema…');
  await migrate();
  await start();
}

main().catch((err: unknown) => {
  console.error('[api] fatal startup error:', err);
  process.exit(1);
});
