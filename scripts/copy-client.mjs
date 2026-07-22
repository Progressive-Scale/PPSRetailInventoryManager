// Copies the built Angular app into the API so the whole thing can be served
// as ONE Railway service in production.
//
// Angular's application builder emits to web/dist/web/browser.
// The API serves static files from api/client (see api/src/main.ts).
import { existsSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Angular >= 17 application builder output. Fall back to the older path just in case.
const candidates = [
  join(root, 'web', 'dist', 'web', 'browser'),
  join(root, 'web', 'dist', 'web'),
];
const source = candidates.find((p) => existsSync(join(p, 'index.html')));

if (!source) {
  console.error(
    '[copy-client] Could not find the built Angular app. Run "npm run build:web" first.\n' +
      'Looked in:\n  ' +
      candidates.join('\n  '),
  );
  process.exit(1);
}

const dest = join(root, 'api', 'client');

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(source, dest, { recursive: true });

console.log(`[copy-client] Copied\n  from ${source}\n  to   ${dest}`);
