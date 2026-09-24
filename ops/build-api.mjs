/**
 * Build the API for production.
 *
 * Why this exists: the dev workflow runs TypeScript directly through `tsx`,
 * which is a devDependency. A production install (`npm ci --omit=dev`) would
 * therefore have no way to start the server. This produces a self-contained
 * bundle that runs on plain `node`.
 *
 *   node ops/build-api.mjs
 *
 * Runtime dependencies (fastify, pg, …) are left external and resolved from
 * node_modules at run time, so native modules are not bundled.
 */

import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = join(ROOT, 'apps/api');
const OUT = join(API, 'dist');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// Entry points: the server, plus the two standalone CLI scripts.
const entries = ['src/index.ts', 'src/db/migrate-cli.ts', 'src/db/topup.ts'];

/**
 * Externalise real runtime dependencies, but NOT the workspace package.
 *
 * `@teo/shared` ships raw TypeScript with extensionless imports; plain node
 * cannot load it, so it must be compiled into the bundle. Everything from
 * node_modules (fastify, pg, …) stays external so native modules load normally.
 */
const pkg = JSON.parse(readFileSync(join(API, 'package.json'), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).filter((d) => d !== '@teo/shared');

await build({
  entryPoints: entries.map((e) => join(API, e)),
  outdir: OUT,
  outbase: join(API, 'src'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  external,
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});

// The migrations directory is read at runtime, relative to the compiled module.
cpSync(join(API, 'src/db/migrations'), join(OUT, 'db/migrations'), { recursive: true });

const size = (p) => `${(statSync(p).size / 1024).toFixed(0)} KB`;
console.log('');
console.log(`  dist/index.js        ${size(join(OUT, 'index.js'))}`);
console.log();
console.log(`  dist/db/migrations/  copied`);
console.log('');
console.log('  Run with:  node apps/api/dist/index.js');
console.log('');
