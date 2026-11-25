import { rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Keep removed/archived source modules out of subsequent release artifacts.
await rm(path.join(root, 'dist'), { recursive: true, force: true });
execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc')], { cwd: root, stdio: 'inherit' });
await import('./generate-config-schema.mjs');
