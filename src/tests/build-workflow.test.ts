import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('building regenerates the editor schema alongside the compiled config code', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-schema-build-'));
  const execute = promisify(execFile);
  try {
    await mkdir(path.join(dir, 'scripts'));
    await mkdir(path.join(dir, 'dist/config'), { recursive: true });
    await mkdir(path.join(dir, 'src/config'), { recursive: true });
    await symlink(path.resolve('node_modules'), path.join(dir, 'node_modules'), 'dir');
    for (const file of ['build.mjs', 'generate-config-schema.mjs']) await cp(path.resolve('scripts', file), path.join(dir, 'scripts', file));
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    await writeFile(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      target: 'ES2022', module: 'ES2022', rootDir: 'src', outDir: 'dist', types: [], skipLibCheck: true,
    }, include: ['src/**/*.ts'] }));
    await writeFile(path.join(dir, 'src/config/v2.ts'), 'export function configJsonSchema() { return { title: "current schema", type: "object" }; }\n');
    const filename = path.join(dir, 'dist/config/config.schema.json');
    const stale = '{"title":"stale schema"}\n';
    await writeFile(filename, stale);
    await execute(process.execPath, ['scripts/build.mjs'], { cwd: dir });
    await execute(process.execPath, ['scripts/generate-config-schema.mjs', '--check'], { cwd: dir });
    assert.equal(JSON.parse(await readFile(filename, 'utf8')).title, 'current schema');
    await assert.rejects(readFile(path.join(dir, 'config.schema.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(dir, 'examples/config.schema.json')), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
