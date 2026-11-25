import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { configJsonSchema } from '../dist/config/v2.js';

const filename = new URL('../dist/config/config.schema.json', import.meta.url);
const content = JSON.stringify(configJsonSchema(), null, 2) + '\n';
if (process.argv.includes('--check')) assert.equal(await readFile(filename, 'utf8'), content, 'Configuration JSON Schema is stale; run npm run build');
else await writeFile(filename, content);
