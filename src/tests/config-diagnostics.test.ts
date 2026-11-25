import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { devNull, tmpdir } from 'node:os';
import { ConfigValidationError, configJsonSchema, loadV2Config, parseV2Config } from '../config/v2.js';
import { readCAFile } from '../runtime/adapters.js';

const input = () => ({ version: 2, instance: { name: 'diagnostic-test', transport: 'stdio', environment: 'test' },
  sources: [{ id: 'db', engine: 'mysql', host: 'localhost', database: 'test', username: 'reader', passwordRef: 'env:TEST_PASSWORD',
    tls: { mode: 'disabled' }, access: {} }] });
function diagnostics(value: unknown) {
  try { parseV2Config(value); assert.fail('invalid configuration accepted'); }
  catch (error) {
    assert.ok(error instanceof ConfigValidationError);
    assert.equal(error.code, 'INVALID_CONFIG');
    return error.diagnostics;
  }
}
test('configuration diagnostics identify known field paths without echoing values or unknown keys', () => {
  const bad = input();
  Object.assign(bad.sources[0], { port: 'PRIVATE_VALUE', PRIVATE_KEY: 'PRIVATE_VALUE' });
  const issues = diagnostics(bad);
  assert.ok(issues.some(issue => issue.path === '$.sources[0].port' && issue.reason === 'INVALID_TYPE'));
  assert.ok(issues.some(issue => issue.path === '$.sources[0]' && issue.reason === 'UNKNOWN_FIELD'));
  assert.ok(!JSON.stringify(issues).includes('PRIVATE'));
  Object.assign(bad.sources[0], { port: 3306, access: { tables: ['reports'], columns: { PRIVATE_FIELD: [''] } } });
  const nested = JSON.stringify(diagnostics(bad));
  assert.ok(!nested.includes('PRIVATE_FIELD')); assert.ok(nested.includes('columns.*'));
});
test('configuration diagnostics explain semantic failures without changing safety defaults', () => {
  const valid = parseV2Config(input());
  assert.equal(valid.instance.tier, 'read_only'); assert.equal(valid.sources[0].access.readScope, 'database');
  assert.equal(valid.sources[0].budgets.maxRows, 200);
  const writer = input(); Object.assign(writer.instance, { tier: 'read_write' });
  assert.deepEqual(diagnostics(writer), [{ path: '$.instance.journal', reason: 'JOURNAL_REQUIRED' }]);
});
test('production read-only sources independently select the database TLS mode', () => {
  const config = input();
  config.instance.environment = 'production';
  const plain = { ...config.sources[0], host: 'mysql.example' };
  const verified = { ...plain, id: 'verified', host: 'redis.example', engine: 'redis', database: 0, tls: { mode: 'verify_identity' } };
  const parsed = parseV2Config({ ...config, sources: [plain, verified] });
  assert.deepEqual(parsed.sources.map(source => [source.tls.mode, source.access.tier]),
    [['disabled', 'read_only'], ['verify_identity', 'read_only']]);
  assert.throws(() => parseV2Config({ ...config, sources: [{ ...plain, tls: undefined }] }), { code: 'INVALID_CONFIG' });
});

test('multi-database configuration rejects excluded defaults and disabled selection, and budgets Redis sessions', () => {
  const mysql = { ...input().sources[0], databaseScope: 'visible' };
  assert.deepEqual(diagnostics({ ...input(), sources: [{ ...mysql, excludeDatabases: ['TEST'] }] }),
    [{ path: '$.sources[0].excludeDatabases', reason: 'DEFAULT_DATABASE_EXCLUDED' }]);
  assert.deepEqual(diagnostics({ ...input(), sources: [{ ...mysql, access: { tier: 'read_write' } }] }),
    [{ path: '$.sources[0].databaseScope', reason: 'DATABASE_SCOPE_READ_ONLY' }]);

  const redis = { ...mysql, id: 'cache', engine: 'redis', database: 0, databases: [1, 2], excludeDatabases: [2] };
  const small = { ...input().instance, budgets: { maxConnections: 1 } };
  assert.deepEqual(diagnostics({ ...input(), instance: small, sources: [redis] }),
    [{ path: '$.instance.budgets.maxConnections', reason: 'CONNECTION_BUDGET_EXCEEDED' }]);
  const safe = parseV2Config({ ...input(), instance: { ...small, budgets: { maxConnections: 2 } }, sources: [redis] });
  assert.equal(safe.sources[0].database, 0);
  assert.deepEqual(diagnostics({ ...input(), sources: [{ ...redis, databaseScope: undefined }] }),
    [{ path: '$.sources[0].databases', reason: 'VISIBLE_DATABASE_SCOPE_REQUIRED' }]);
});
test('MySQL accepts hyphenated default and excluded database names and keeps table restrictions', () => {
  const config = input();
  const source = { ...config.sources[0], database: 'reporting-north', databaseScope: 'visible', excludeDatabases: ['reporting-private'] };
  assert.equal(parseV2Config({ ...config, sources: [source] }).sources[0].database, 'reporting-north');
  assert.deepEqual(diagnostics({ ...config, sources: [{ ...source, excludeDatabases: ['REPORTING-NORTH'] }] }),
    [{ path: '$.sources[0].excludeDatabases', reason: 'DEFAULT_DATABASE_EXCLUDED' }]);
  assert.ok(diagnostics({ ...config, sources: [{ ...source, access: { tables: ['table-name'] } }] })
    .some(issue => issue.path === '$.sources[0].access.tables[0]'));
});
test('each database source needs exactly one inline credential or reference', () => {
  const config = input();
  const { passwordRef, ...mysql } = config.sources[0];
  const sources = [
    [{ ...mysql, password: ' inline fixture ' }, 'password', 'passwordRef', passwordRef],
    [{ id: 'redis', engine: 'redis', host: 'localhost', tls: mysql.tls, access: {}, password: ' inline fixture ' },
      'password', 'passwordRef', passwordRef],
    [{ id: 'mongo', engine: 'mongodb', database: 'test', tls: mysql.tls, access: {},
      connectionString: 'mongodb://reader:fixture@localhost/test' }, 'connectionString', 'connectionStringRef', 'env:TEST_URI'],
  ] as const;
  for (const [source, key, ref, reference] of sources) {
    const candidate = (value: object) => ({ ...config, sources: [value] });
    assert.equal(Reflect.get(parseV2Config(candidate(source)).sources[0], key), Reflect.get(source, key));
    assert.deepEqual(diagnostics(candidate({ ...source, [ref]: reference })),
      [{ path: '$.sources[0].' + key, reason: 'CREDENTIAL_CONFLICT' }]);
    assert.deepEqual(diagnostics(candidate({ ...source, [key]: undefined })),
      [{ path: '$.sources[0].' + ref, reason: 'CREDENTIAL_REQUIRED' }]);
    assert.deepEqual(diagnostics(candidate({ ...source, [key]: 'PRIVATE_VALUE\0' })),
      [{ path: '$.sources[0].' + key, reason: 'INVALID_VALUE' }]);
    assert.deepEqual(diagnostics(candidate({ ...source, [key]: '界'.repeat(22000) })),
      [{ path: '$.sources[0].' + key, reason: 'INVALID_VALUE' }]);
  }
});
test('allowedTools diagnostics identify the source and list index without echoing tool names', () => {
  const valid = input();
  Object.assign(valid.sources[0].access, { allowedTools: ['mysql_select', 'mysql_prepare_write'] });
  assert.deepEqual(parseV2Config(valid).sources[0].access.allowedTools, ['mysql_select', 'mysql_prepare_write']);
  for (const [tool, reason] of [
    ['redis_get', 'TOOL_ENGINE_MISMATCH'],
    ['PRIVATE_UNKNOWN_TOOL', 'UNKNOWN_TOOL'],
    ['list_sources', 'TOOL_NOT_SOURCE_SCOPED'],
  ]) {
    const invalidSource = { ...valid.sources[0], id: 'second', access: { allowedTools: ['mysql_select', tool] } };
    assert.deepEqual(diagnostics({ ...valid, sources: [...valid.sources, invalidSource] }), [
      { path: '$.sources[1].access.allowedTools[1]', reason },
    ]);
  }
});
test('config JSON Schema describes editable input without executing secrets or semantic transforms', () => {
  const schema = configJsonSchema();
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.additionalProperties, false);
  const text = JSON.stringify(schema);
  for (const field of ['passwordRef', 'readScope', 'hostKeySha256', 'maxRows']) assert.ok(text.includes(field));
  assert.ok(text.includes('runtime')); assert.ok(!text.includes('PRIVATE_VALUE'));
});
test('configuration file diagnostics distinguish invalid JSON and missing files without leaking content or filenames', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'db-mcp-diagnostics-'));
  try {
    const filename = path.join(directory, 'PRIVATE_FILENAME.json');
    await writeFile(filename, '{"PRIVATE_VALUE":');
    await assert.rejects(loadV2Config(filename), error => error instanceof ConfigValidationError &&
      JSON.stringify(error.diagnostics) === '[{"path":"$","reason":"INVALID_JSON"}]');
    await assert.rejects(loadV2Config(path.join(directory, 'PRIVATE_MISSING')), error => error instanceof ConfigValidationError &&
      JSON.stringify(error.diagnostics) === '[{"path":"$","reason":"CONFIG_UNREADABLE"}]');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('inline credentials require a private local configuration file and are redacted in --check', {
  skip: !process.getuid, timeout: 10000,
}, async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execute = promisify(execFile);
  const directory = await mkdtemp(path.join(tmpdir(), 'db-mcp-inline-'));
  try {
    const filename = path.join(directory, 'config.json');
    const link = path.join(directory, 'link.json');
    const config = input();
    const { passwordRef, ...mysql } = config.sources[0];
    const password = 'PRIVATE_INLINE_PASSWORD';
    const inline = { ...config, sources: [{ ...mysql, password }] };
    await writeFile(filename, JSON.stringify(inline), { mode: 0o600 });
    await chmod(filename, 0o644);
    const unsafeConfig = (error: unknown) => error instanceof ConfigValidationError &&
      JSON.stringify(error.diagnostics) === '[{"path":"$","reason":"CONFIG_SECRET_FILE_UNSAFE"}]';
    await assert.rejects(loadV2Config(filename), unsafeConfig);
    await chmod(filename, 0o600);
    await symlink(filename, link);
    await assert.rejects(loadV2Config(link), unsafeConfig);
    const check = (file: string) => execute(process.execPath, ['--import', 'tsx', path.resolve('src/index.ts'), '--config', file, '--check'], {
      env: { ...process.env, DB_MCP_CONFIG: '', TEST_PASSWORD: '' },
    });
    const checked = await check(filename);
    assert.equal(checked.stdout, '');
    assert.match(checked.stderr, /CONFIG_VALID/);
    assert.doesNotMatch(checked.stderr, /PRIVATE_INLINE/);
    const mongo = { id: 'mongo', engine: 'mongodb', database: 'test', tls: mysql.tls, access: {} };
    await writeFile(filename, JSON.stringify({ ...config, sources: [{ ...mongo, connectionString: 'PRIVATE_INLINE_MALFORMED_URI' }] }));
    await assert.rejects(check(filename), error => {
      const result = error as Error & { stderr: string; stdout: string; code: number };
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.doesNotMatch(result.stderr, /PRIVATE_INLINE/);
      return true;
    });
    await writeFile(filename, JSON.stringify(config));
    await chmod(filename, 0o644);
    assert.equal(Reflect.get((await loadV2Config(link)).sources[0], 'passwordRef'), passwordRef);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CA files allow regular bundle links and reject nonregular or oversized sources', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'db-mcp-ca-'));
  try {
    const file = path.join(directory, 'bundle.pem');
    const link = path.join(directory, 'current.pem');
    const contents = Buffer.alloc(1024 * 1024, 65);
    await writeFile(file, contents);
    await symlink(file, link);
    assert.deepEqual(await readCAFile(link), contents);
    await assert.rejects(readCAFile(devNull), { code: 'INVALID_CONFIG' });
    await truncate(file, contents.length + 1);
    await assert.rejects(readCAFile(link), { code: 'INVALID_CONFIG' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('local --check reports safe diagnostics and effective tools while schema printing stays offline', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execute = promisify(execFile);
  const directory = await mkdtemp(path.join(tmpdir(), 'db-mcp-check-'));
  const entry = path.resolve('src/index.ts');
  const env = { ...process.env, DB_MCP_CONFIG: '', TEST_PASSWORD: 'PRIVATE_CHECK_SECRET' };
  try {
    const filename = path.join(directory, 'config.json');
    const valid = input(); valid.sources[0].host = 'PRIVATE_HOST'; valid.sources[0].tls.mode = 'verify_identity';
    Object.assign(valid.sources[0].access, { allowedTools: ['mysql_select', 'mysql_prepare_write'] });
    await writeFile(filename, JSON.stringify(valid));
    const checked = await execute(process.execPath, ['--import', 'tsx', entry, '--config', filename, '--check'], { env });
    assert.equal(checked.stdout, ''); assert.ok(checked.stderr.includes('CONFIG_VALID'));
    assert.ok(checked.stderr.includes('effective_configuration')); assert.ok(checked.stderr.includes('mysql_select'));
    assert.doesNotMatch(checked.stderr, /PRIVATE_|mysql_prepare_write/);
    for (const [tool, reason] of [['redis_get', 'TOOL_ENGINE_MISMATCH'], ['PRIVATE_UNKNOWN_TOOL', 'UNKNOWN_TOOL']]) {
      const invalid = { ...valid, sources: [{ ...valid.sources[0], access: { allowedTools: ['mysql_select', tool] } }] };
      await writeFile(filename, JSON.stringify(invalid));
      await assert.rejects(execute(process.execPath, ['--import', 'tsx', entry, '--config', filename, '--check'], { env }), error => {
        const result = error as Error & { stderr: string; stdout: string; code: number };
        assert.equal(result.code, 1); assert.equal(result.stdout, '');
        const event = result.stderr.split('\n').find(line => line.startsWith('{'));
        assert.ok(event, result.stderr);
        assert.deepEqual(JSON.parse(event), { type: 'config_diagnostics', issues: [{ path: '$.sources[0].access.allowedTools[1]', reason }] });
        assert.ok(!result.stderr.includes(tool)); assert.doesNotMatch(result.stderr, /PRIVATE_/);
        return true;
      });
    }
    Object.assign(valid.sources[0], { port: 'PRIVATE_VALUE' });
    await writeFile(filename, JSON.stringify(valid));
    await assert.rejects(execute(process.execPath, ['--import', 'tsx', entry, '--config', filename, '--check'], { env }), error => {
      const result = error as Error & { stderr: string; stdout: string; code: number };
      assert.equal(result.code, 1); assert.equal(result.stdout, '');
      assert.ok(result.stderr.includes('$.sources[0].port')); assert.ok(result.stderr.includes('INVALID_TYPE'));
      assert.ok(!result.stderr.includes('PRIVATE_')); return true;
    });
    const printed = await execute(process.execPath, ['--import', 'tsx', entry, '--print-config-schema'], { env });
    assert.equal(JSON.parse(printed.stdout).title, 'db-mcp v2 configuration'); assert.equal(printed.stderr, '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
