import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

for (const scenario of ['explicit', 'omitted-tiers', 'database-scope'] as const) test('real stdio entry exposes only fixed read tools and redacts startup/call errors: ' +
  scenario, { timeout: 15000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-protocol-'));
  const sentinel = 'test-only-secret-never-echo';
  const filename = path.join(dir, 'v2.json');
  const config = { version: 2, instance: { name: 'protocol', transport: 'stdio', environment: 'test', tier: 'read_only' },
    sources: [{ id: 'offline', engine: 'mysql', required: false, host: '127.0.0.1', port: 1, database: 'test', username: 'reader',
      passwordRef: 'env:TEST_PASSWORD', tls: { mode: 'disabled' }, budgets: { connectTimeoutMs: 100 },
      access: { tier: 'read_only', tables: ['reports'], columns: { reports: ['name'] } } }] };
  if (scenario !== 'explicit') { Reflect.deleteProperty(config.instance, 'tier'); Reflect.deleteProperty(config.sources[0].access, 'tier'); }
  if (scenario === 'database-scope') {
    Reflect.deleteProperty(config.sources[0].access, 'tables'); Reflect.deleteProperty(config.sources[0].access, 'columns');
  }
  await writeFile(filename, JSON.stringify(config));
  let stderr = '';
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/index.js'), '--config', filename],
    env: { TEST_PASSWORD: sentinel, DB_MCP_SECURITY_MODE: 'full_access' }, stderr: 'pipe' });
  const client = new Client({ name: 'db-mcp-test', version: '1.0.0' });
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(t => t.name), ['list_sources', 'server_runtime_status', 'mysql_list_tables', 'mysql_select', 'mysql_describe_table']);
    for (const name of ['mysql_connect', 'mysql_query', 'mysql_update', 'set_security_mode',
      'mysql_prepare_write', 'mongodb_prepare_write', 'redis_prepare_write', 'commit_write', 'operation_status']) {
      const denied = await client.callTool({ name, arguments: { password: sentinel } });
      assert.equal(denied.isError, true);
      assert.equal(JSON.parse((denied.content as Array<{ text: string }>)[0].text).error.code, 'SCOPE_DENIED');
    }
    const status = await client.callTool({ name: 'list_sources', arguments: {} });
    assert.ok(JSON.stringify(status).includes('unavailable'));
    assert.ok(!JSON.stringify(status).includes('127.0.0.1'));
    const unavailable = await client.callTool({ name: 'mysql_select', arguments: { sourceId: 'offline', table: 'reports' } });
    assert.equal(unavailable.isError, true);
    assert.ok(!JSON.stringify(unavailable).includes(sentinel));
    const alternate = await client.callTool({ name: 'mysql_list_tables', arguments: { sourceId: 'offline', database: 'other-db' } });
    assert.equal(alternate.isError, true);
    const alternateError = JSON.parse((alternate.content as Array<{ text: string }>)[0].text).error;
    assert.equal(alternateError.code, 'INVALID_ARGUMENT');
    assert.equal(alternateError.details.reason, 'database_selection_disabled');
    assert.ok(!stderr.includes(sentinel));
    const checked = await promisify(execFile)(process.execPath, [path.resolve('dist/index.js'), '--config', filename, '--check'], { env: { TEST_PASSWORD: sentinel } });
    assert.equal(checked.stdout, '');
    assert.ok(checked.stderr.includes('CONFIG_VALID'));
  } finally { await client.close(); await transport.close(); await rm(dir, { recursive: true }); }
});

test('real stdio exposes source-specific tool arguments and actionable errors in the legacy text result', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-tool-discovery-'));
  const filename = path.join(dir, 'v2.json');
  const fixtureSecret = 'non-disclosed-mcp-fixture';
  const local = { required: false, tls: { mode: 'disabled' }, budgets: { connectTimeoutMs: 100, maxRows: 12 } };
  const redis = { ...local, engine: 'redis', host: '127.0.0.1', port: 1, passwordRef: 'env:TEST_PASSWORD' };
  const config = { version: 2, instance: { name: 'tool-discovery', transport: 'stdio', environment: 'test' }, sources: [
    { ...redis, id: 'scanner', purpose: 'Paginated report keys',
      access: { keyPrefixes: ['reports:'], allowKeyspaceScan: true, allowedTools: ['redis_keys', 'redis_get_range'] } },
    { ...redis, id: 'types',
      access: { keyPrefixes: ['undisclosed-prefix:'], allowKeyspaceScan: true, allowedTools: ['redis_type'] } },
    { ...local, id: 'documents', engine: 'mongodb', database: 'test', connectionStringRef: 'env:TEST_MONGO', access: {} },
  ] };
  await writeFile(filename, JSON.stringify(config));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.resolve('dist/index.js'), '--config', filename],
    env: { TEST_PASSWORD: fixtureSecret, TEST_MONGO: 'mongodb://reader:' + fixtureSecret + '@127.0.0.1:1/test' }, stderr: 'pipe',
  });
  const client = new Client({ name: 'db-mcp-discovery-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    assert.match(client.getInstructions() ?? '', /nextCursor.*nextOffset/);
    const { tools } = await client.listTools();
    const schemaFor = (name: string) => tools.find(tool => tool.name === name)?.inputSchema.properties;
    assert.deepEqual((schemaFor('redis_keys')?.sourceId as { enum: string[] }).enum, ['scanner']);
    assert.deepEqual((schemaFor('redis_type')?.sourceId as { enum: string[] }).enum, ['types']);
    assert.equal((schemaFor('redis_keys')?.prefix as { default?: string }).default, undefined);

    const call = async (name: string, args: Record<string, unknown>, isError?: boolean) => {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, isError);
      assert.equal(result.structuredContent, undefined);
      const content = result.content as Array<{ type: string; text: string }>;
      assert.equal(content[0].type, 'text');
      assert.ok(!content[0].text.includes(fixtureSecret));
      return JSON.parse(content[0].text);
    };
    const { sources } = await call('list_sources', {});
    const [scanner, types, documents] = sources;
    assert.equal(scanner.id, 'scanner');
    assert.equal(scanner.engine, 'redis');
    assert.equal(scanner.purpose, 'Paginated report keys');
    assert.equal(scanner.status, 'unavailable');
    assert.equal(scanner.readScope, 'allowlist');
    assert.equal(scanner.maxRows, 12);
    assert.deepEqual(scanner.enabledTools.sort(), ['redis_get_range', 'redis_keys']);
    assert.deepEqual(scanner.scanPrefixes, ['reports:']);
    assert.deepEqual(types.enabledTools, ['redis_type']);
    assert.equal(types.scanPrefixes, undefined);
    assert.equal(documents.readScope, 'database');
    assert.ok(!JSON.stringify(sources).includes('127.0.0.1'));

    const sort = await call('mongodb_find', { sourceId: 'documents', collection: 'reports',
      orderBy: [{ field: 'id', direction: fixtureSecret }] }, true);
    assert.equal(sort.error.code, 'INVALID_ARGUMENT');
    assert.equal(typeof sort.error.requestId, 'string');
    assert.equal(sort.error.details.path, '$.orderBy[0].direction');
    assert.equal(sort.error.details.nextAction, 'check_arguments');
    assert.match(sort.error.message, /asc.*desc/);

    const selector = await call('mongodb_find', { sourceId: 'documents', collection: 'reports',
      filter: { [fixtureSecret + ' field']: 'not disclosed' } }, true);
    assert.equal(selector.error.code, 'SCOPE_DENIED');

    const prefix = await call('redis_keys', { sourceId: 'scanner' }, true);
    assert.equal(prefix.error.code, 'SCOPE_DENIED');
    assert.equal(prefix.error.details.path, '$.prefix');
    assert.equal(prefix.error.details.nextAction, 'check_scan_prefixes');

    const cursor = await call('redis_keys', { sourceId: 'scanner', prefix: 'reports:', cursor: fixtureSecret }, true);
    assert.equal(cursor.error.code, 'INVALID_ARGUMENT');
    assert.equal(cursor.error.details.reason, 'invalid_cursor');
    assert.equal(cursor.error.details.nextAction, 'restart_pagination');

    const unavailable = await call('redis_get_range', { sourceId: 'scanner', key: 'reports:item' }, true);
    assert.equal(unavailable.error.code, 'SOURCE_UNAVAILABLE');
    assert.equal(unavailable.error.details.nextAction, 'check_source_status');
  } finally { await client.close(); await transport.close(); await rm(dir, { recursive: true }); }
});

test('real stdio stays available after only the stderr receiver closes', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-stderr-'));
  const filename = path.join(dir, 'v2.json');
  const config = { version: 2, instance: { name: 'stderr-fault', transport: 'stdio', environment: 'test', tier: 'read_only' },
    sources: [{ id: 'offline', engine: 'mysql', required: false, host: '127.0.0.1', port: 1, database: 'test', username: 'reader',
      passwordRef: 'env:TEST_PASSWORD', tls: { mode: 'disabled' }, budgets: { connectTimeoutMs: 100 },
      access: { tier: 'read_only', tables: ['reports'], columns: { reports: ['name'] } } }] };
  await writeFile(filename, JSON.stringify(config));
  const child = spawn(process.execPath, [path.resolve('dist/index.js'), '--config', filename], {
    env: { TEST_PASSWORD: 'test-only-stderr-secret' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const output = createInterface({ input: child.stdout });
  type StdioResponse = { id: number; result: { serverInfo?: { name: string }; isError?: boolean; content?: unknown[] } };
  const pending = new Map<number, { resolve(value: StdioResponse): void; reject(error: Error): void }>();
  let nextId = 1;
  const rejectPending = (error: Error) => { for (const request of pending.values()) request.reject(error); pending.clear(); };
  child.on('error', rejectPending);
  child.stdin.on('error', rejectPending);
  child.once('close', (code, signal) => rejectPending(new Error(`stdio child closed: ${code ?? signal}`)));
  child.stderr.on('error', () => {});
  child.stderr.resume();
  output.on('line', line => {
    try {
      const message: StdioResponse = JSON.parse(line);
      const request = pending.get(message.id);
      if (request) { pending.delete(message.id); request.resolve(message); }
    } catch { rejectPending(new Error('invalid stdio response')); }
  });
  const request = (method: string, params: unknown) => new Promise<StdioResponse>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) { reject(new Error('stdio child already exited')); return; }
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`stdio request timed out: ${method}`)); }, 5000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    const initialized = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'stderr-fault-test', version: '1.0.0' } });
    assert.equal(initialized.result.serverInfo?.name, 'db-mcp');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    assert.ok((await request('tools/call', { name: 'list_sources', arguments: {} })).result);
    const stderrClosed = once(child.stderr, 'close');
    child.stderr.destroy();
    await stderrClosed;
    // Every call emits an audit event. Later responses prove the process survived the
    // asynchronous pipe error, rather than just replying before the error was raised.
    for (let i = 0; i < 3; i++) {
      const response = await request('tools/call', { name: 'list_sources', arguments: {} });
      assert.equal(response.result.isError, undefined);
      assert.ok(JSON.stringify(response.result).includes('unavailable'));
    }
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
  } finally {
    child.stdin.end();
    const deadline = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { await closed; } finally { clearTimeout(deadline); output.close(); rejectPending(new Error('test cleanup')); await rm(dir, { recursive: true }); }
  }
});
