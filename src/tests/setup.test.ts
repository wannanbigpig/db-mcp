import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, stat, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSetupConfig, saveSetup, runSetup, type SetupAnswers, type SetupPrompt } from '../config/setup.js';
import { parseV2Config } from '../config/v2.js';
import { resolveSecret } from '../config/secrets.js';
import { validateMongoURI } from '../runtime/adapters.js';
import { clientKey, sshFixture } from './helpers/ssh.js';

const password = '  fixture-only-密码@:/?#%+$  ';
const entrypoint = path.resolve('dist/index.js');
const executable = '/fixture-only/bin/node';
const baseAnswers = (engine: SetupAnswers['engine'] = 'mysql'): SetupAnswers => ({
  engine, localDevelopment: false, host: 'db.internal.example', port: engine === 'mysql' ? 3306 : engine === 'redis' ? 6379 : 27017,
  database: 'reporting', username: 'mcp_reader', password,
  ...(engine === 'redis' ? { keyPrefixes: ['reports:'], redisDatabase: 3 } : { objects: [{ name: 'reports', fields: ['id', 'name'] }] }),
});
const secretPath = '/fixture-only/db-mcp/secret';

test('setup builds a frozen MySQL read-only configuration with explicit field scope and an unchanged password', () => {
  const { config, secret } = createSetupConfig({ ...baseAnswers(), localDevelopment: true, host: '127.0.0.1' }, secretPath);
  const source = config.sources[0]; assert.equal(source.engine, 'mysql'); if (source.engine !== 'mysql') throw new Error();
  assert.equal(config.instance.environment, 'development'); assert.equal(config.instance.tier, 'read_only');
  assert.equal(config.instance.journal, undefined); assert.equal(source.access.tier, 'read_only');
  assert.equal(Reflect.get(source.access, 'readScope'), 'allowlist');
  assert.equal(source.access.writes, undefined); assert.equal(source.access.rawSql, false);
  assert.equal(source.passwordRef, 'file:' + secretPath); assert.deepEqual(source.access.tables, ['reports']);
  assert.deepEqual(source.access.columns, { reports: ['id', 'name'] }); assert.deepEqual(source.tls, { mode: 'disabled' });
  assert.equal(secret, password); assert.ok(!JSON.stringify(config).includes(password));
  assert.ok(Object.isFrozen(config)); assert.ok(Object.isFrozen(source.access));
  assert.deepEqual(parseV2Config(config), config);
});

test('setup builds a Redis read-only profile without scanning, scripts or implicit writes', () => {
  const { config, secret } = createSetupConfig({ ...baseAnswers('redis'), caFile: '/fixture-only/ca.pem' }, secretPath);
  const source = config.sources[0]; assert.equal(source.engine, 'redis'); if (source.engine !== 'redis') throw new Error();
  assert.equal(config.instance.environment, 'production'); assert.equal(config.instance.tier, 'read_only');
  assert.equal(source.access.tier, 'read_only'); assert.equal(source.access.writes, undefined);
  assert.equal(Reflect.get(source.access, 'readScope'), 'allowlist');
  assert.equal(source.access.allowKeyspaceScan, false); assert.equal(source.database, 3);
  assert.deepEqual(source.access.keyPrefixes, ['reports:']); assert.equal(source.passwordRef, 'file:' + secretPath);
  assert.deepEqual(source.tls, { mode: 'verify_identity', caFile: '/fixture-only/ca.pem' }); assert.equal(secret, password);
});

test('setup encodes MongoDB credentials without changing their characters or exposing the URI in config', () => {
  const username = 'reader@:/?#%+$';
  const { config, secret } = createSetupConfig({ ...baseAnswers('mongodb'), username, authSource: 'admin',
    objects: [{ name: 'reports', fields: ['_id.tenant', 'profile.name'] }] }, secretPath);
  const source = config.sources[0]; assert.equal(source.engine, 'mongodb'); if (source.engine !== 'mongodb') throw new Error();
  const uri = new URL(secret);
  assert.equal(decodeURIComponent(uri.username), username); assert.equal(decodeURIComponent(uri.password), password);
  assert.equal(uri.hostname, 'db.internal.example'); assert.equal(uri.port, '27017'); assert.equal(uri.pathname, '/reporting');
  assert.equal(uri.searchParams.get('authSource'), 'admin'); assert.equal(source.connectionStringRef, 'file:' + secretPath);
  assert.deepEqual(source.access.fields, { reports: ['_id.tenant', 'profile.name'] });
  assert.equal(source.access.tier, 'read_only'); assert.equal(source.access.writes, undefined);
  assert.equal(Reflect.get(source.access, 'readScope'), 'allowlist');
  assert.equal(validateMongoURI(secret, source, config), secret);
  assert.ok(!JSON.stringify(config).includes(secret)); assert.ok(!JSON.stringify(config).includes(password));
});

test('setup requires complete scope when allowlist is explicitly chosen', () => {
  const invalid: SetupAnswers[] = [
    { ...baseAnswers(), objects: undefined }, { ...baseAnswers(), objects: [] },
    { ...baseAnswers(), objects: [{ name: 'reports', fields: [] }] },
    { ...baseAnswers(), objects: [{ name: 'reports', fields: ['constructor'] }] },
    { ...baseAnswers('mongodb'), objects: [{ name: 'reports', fields: [] }] },
    { ...baseAnswers('mongodb'), objects: [{ name: 'reports', fields: ['profile.__proto__'] }] },
    { ...baseAnswers('redis'), keyPrefixes: undefined }, { ...baseAnswers('redis'), keyPrefixes: [] },
    { ...baseAnswers('redis'), keyPrefixes: ['reports:*'] },
  ];
  for (const answers of invalid) assert.throws(() => createSetupConfig(Object.assign(answers, { readScope: 'allowlist' }), secretPath), { code: 'INVALID_CONFIG' });
});

test('setup defaults to the whole fixed database only when no object or prefix restriction was supplied', () => {
  for (const engine of ['mysql', 'redis', 'mongodb'] as const) {
    const answers = baseAnswers(engine); Reflect.deleteProperty(answers, 'objects'); Reflect.deleteProperty(answers, 'keyPrefixes');
    const { config, secret } = createSetupConfig(answers, secretPath);
    const source = config.sources[0]; assert.equal(source.engine, engine);
    assert.equal(config.instance.tier, 'read_only'); assert.equal(config.instance.journal, undefined);
    assert.equal(source.access.tier, 'read_only'); assert.equal(source.access.writes, undefined);
    assert.equal(Reflect.get(source.access, 'readScope'), 'database');
    for (const name of ['tables','collections','keyPrefixes']) assert.deepEqual(Reflect.get(source.access, name) ?? [], []);
    for (const name of ['columns','fields']) assert.deepEqual(Reflect.get(source.access, name) ?? {}, {});
    if (source.engine === 'redis') assert.equal(source.access.allowKeyspaceScan, false);
    assert.deepEqual(parseV2Config(config), config); assert.ok(!JSON.stringify(config).includes(password));
    if (source.engine !== 'mongodb') assert.equal(secret, password);
    else assert.equal(decodeURIComponent(new URL(secret).password), password);
    const explicit = createSetupConfig(Object.assign(answers, { readScope: 'database', objects: [], keyPrefixes: [] }), secretPath).config;
    assert.equal(Reflect.get(explicit.sources[0].access, 'readScope'), 'database'); assert.deepEqual(parseV2Config(explicit), explicit);
  }
});

test('database setup never silently ignores a supplied object or key-prefix restriction', () => {
  for (const engine of ['mysql', 'redis', 'mongodb'] as const) {
    assert.throws(() => createSetupConfig(Object.assign(baseAnswers(engine), { readScope: 'database' }), secretPath), { code: 'INVALID_CONFIG' });
    const blank = baseAnswers(engine); Reflect.deleteProperty(blank, 'objects'); Reflect.deleteProperty(blank, 'keyPrefixes');
    for (const restriction of [{ objects: [{ name: 'reports', fields: ['name'] }] }, { keyPrefixes: ['reports:'] }]) {
      assert.throws(() => createSetupConfig(Object.assign({}, blank, restriction, { readScope: 'database' }), secretPath), { code: 'INVALID_CONFIG' });
    }
    for (const restriction of [{ objects: {} }, { keyPrefixes: {} }]) {
      assert.throws(() => createSetupConfig(Object.assign({}, blank, restriction, { readScope: 'database' }) as SetupAnswers, secretPath), { code: 'INVALID_CONFIG' });
    }
    for (const restriction of [{ objects: [] }, { keyPrefixes: [] }]) {
      assert.throws(() => createSetupConfig(Object.assign({}, blank, restriction), secretPath), { code: 'INVALID_CONFIG' });
    }
  }
});

test('Redis setup can use the existing default account without enabling writes or scanning', () => {
  const { config } = createSetupConfig({ ...baseAnswers('redis'), username: 'default' }, secretPath);
  const source = config.sources[0]; if (source.engine !== 'redis') throw new Error();
  assert.equal(source.username, 'default'); assert.equal(source.access.tier, 'read_only');
  assert.equal(source.access.writes, undefined); assert.equal(source.access.allowKeyspaceScan, false);
});

test('production setup verifies TLS identity and never silently relaxes MySQL IP verification', () => {
  for (const engine of ['mysql', 'redis', 'mongodb'] as const) {
    const { config } = createSetupConfig(baseAnswers(engine), secretPath);
    assert.equal(config.instance.environment, 'production'); assert.equal(config.sources[0].tls.mode, 'verify_identity');
  }
  assert.throws(() => createSetupConfig({ ...baseAnswers(), host: '127.0.0.1' }, secretPath), { code: 'INVALID_CONFIG' });
});

test('plaintext setup requires explicit local development and an actual loopback host for every engine', () => {
  for (const engine of ['mysql', 'redis', 'mongodb'] as const) {
    const answers = { ...baseAnswers(engine), localDevelopment: true, host: engine === 'mongodb' ? '::1' : 'localhost' };
    const { config, secret } = createSetupConfig(answers, secretPath);
    assert.equal(config.instance.environment, 'development'); assert.deepEqual(config.sources[0].tls, { mode: 'disabled' });
    if (config.sources[0].engine === 'mongodb') {
      assert.equal(new URL(secret).hostname, '[::1]'); assert.equal(validateMongoURI(secret, config.sources[0], config), secret);
    }
    assert.throws(() => createSetupConfig({ ...answers, host: 'db.internal.example' }, secretPath), { code: 'INVALID_CONFIG' });
  }
});

test('setup rejects empty, multiline, NUL or oversized UTF-8 passwords without trimming valid spaces', () => {
  for (const value of ['', 'bad\0password', 'bad\rpassword', 'bad\npassword', '中'.repeat(21846)]) {
    assert.throws(() => createSetupConfig({ ...baseAnswers(), password: value }, secretPath), { code: 'INVALID_CONFIG' });
  }
  // A valid raw password can expand beyond the mounted-secret limit after URI encoding.
  assert.throws(() => createSetupConfig({ ...baseAnswers('mongodb'), password: '@'.repeat(22000) }, secretPath), { code: 'INVALID_CONFIG' });
  assert.equal(createSetupConfig({ ...baseAnswers(), password: ' ' }, secretPath).secret, ' ');
});

test('setup persists only private new files and preserves existing configuration and secrets', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-setup-private-'));
  try {
    await writeFile(path.join(dir, 'config.json'), 'existing-config', { mode: 0o600 });
    await writeFile(path.join(dir, 'secret'), 'existing-secret', { mode: 0o600 });
    const result = await saveSetup(baseAnswers(), dir, entrypoint, executable);
    const profile = path.dirname(result.configPath);
    assert.equal(path.dirname(profile), dir); assert.ok(path.basename(profile).startsWith('profile-'));
    assert.equal(path.dirname(result.clientConfigPath), profile); assert.equal((await stat(profile)).mode & 0o777, 0o700);
    const saved = JSON.parse(await readFile(result.configPath, 'utf8'));
    assert.equal(saved.instance.budgets, undefined);
    assert.equal(saved.sources[0].budgets, undefined);
    assert.equal(saved.sources[0].required, undefined);
    assert.deepEqual(Object.keys(saved.sources[0].access).sort(), ['columns', 'readScope', 'tables']);
    const config = parseV2Config(saved);
    const source = config.sources[0]; if (source.engine !== 'mysql') throw new Error();
    assert.ok(source.passwordRef);
    const savedSecret = source.passwordRef.slice(5); assert.equal(path.dirname(savedSecret), profile);
    for (const file of [result.configPath, result.clientConfigPath, savedSecret]) {
      const info = await stat(file); assert.ok(info.isFile()); assert.equal(info.mode & 0o777, 0o600);
      if (process.getuid) assert.equal(info.uid, process.getuid());
    }
    assert.equal(await resolveSecret(source.passwordRef), password);
    const client = JSON.parse(await readFile(result.clientConfigPath, 'utf8'));
    assert.deepEqual(client, { mcpServers: { 'db-mcp': { command: executable, args: [entrypoint, '--config', result.configPath] } } });
    assert.ok(!JSON.stringify(client).includes(password)); assert.ok(!JSON.stringify(config).includes(password));
    assert.equal(await readFile(path.join(dir, 'config.json'), 'utf8'), 'existing-config');
    assert.equal(await readFile(path.join(dir, 'secret'), 'utf8'), 'existing-secret');
    assert.deepEqual((await readdir(dir)).sort(), ['config.json', path.basename(profile), 'secret'].sort());
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('repeated setup creates independent profiles rather than overwriting a prior connection', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-setup-repeat-'));
  try {
    const first = await saveSetup(baseAnswers(), dir, entrypoint, executable);
    const snapshot = await readFile(first.configPath, 'utf8');
    const second = await saveSetup({ ...baseAnswers(), password: 'another-fixture-secret' }, dir, entrypoint, executable);
    assert.notEqual(path.dirname(first.configPath), path.dirname(second.configPath));
    assert.equal(await readFile(first.configPath, 'utf8'), snapshot); assert.equal((await readdir(dir)).length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a missing CA rejects setup after staging and cleans only the new profile', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-setup-ca-failure-'));
  try {
    await writeFile(path.join(dir, 'config.json'), 'existing-config', { mode: 0o600 });
    await writeFile(path.join(dir, 'secret'), 'existing-secret', { mode: 0o600 });
    await assert.rejects(saveSetup({ ...baseAnswers(), caFile: path.join(dir, 'missing-ca.pem') }, dir, entrypoint, executable), error => {
      assert.ok(!String(error).includes(password)); assert.ok(!String(error).includes(dir)); return true;
    });
    assert.deepEqual((await readdir(dir)).sort(), ['config.json', 'secret']);
    assert.equal(await readFile(path.join(dir, 'config.json'), 'utf8'), 'existing-config');
    assert.equal(await readFile(path.join(dir, 'secret'), 'utf8'), 'existing-secret');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an already aborted setup never creates the destination directory or persists a password', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-setup-pre-abort-'));
  try {
    const destination = path.join(dir, 'not-created');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(saveSetup(baseAnswers(), destination, entrypoint, undefined, controller.signal), error => {
      assert.ok(!String(error).includes(password)); assert.ok(!String(error).includes(destination)); return true;
    });
    assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('setup rejects a symlink or shared destination without leaking inputs or writing through it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-setup-unsafe-'));
  const target = await mkdtemp(path.join(tmpdir(), 'db-mcp-setup-target-'));
  try {
    const link = path.join(dir, 'linked-directory'); await symlink(target, link, 'dir');
    const rejectSafely = (error: unknown) => {
      const message = String(error); assert.ok(!message.includes(password)); assert.ok(!message.includes(dir)); assert.ok(!message.includes(target)); return true;
    };
    await assert.rejects(saveSetup(baseAnswers(), link, entrypoint, executable), rejectSafely);
    assert.deepEqual(await readdir(target), []);
    await chmod(dir, 0o755);
    await assert.rejects(saveSetup(baseAnswers(), dir, entrypoint, executable), rejectSafely);
    assert.deepEqual(await readdir(dir), ['linked-directory']);
  } finally { await rm(dir, { recursive: true, force: true }); await rm(target, { recursive: true, force: true }); }
});

function mockPrompt(values: string[], cancel = false) {
  const calls: Array<{ label: string; options?: { secret?: boolean; defaultValue?: string } }> = [];
  const messages: string[] = []; let closed = 0;
  const prompt: SetupPrompt = {
    ask: async (label, options) => {
      calls.push({ label, options });
      if (cancel) throw new Error('RAW_PROMPT_FAILURE ' + password);
      const value = values.shift(); if (value === undefined) throw new Error('Unexpected extra setup question'); return value;
    },
    write: message => { messages.push(message); }, close: () => { closed++; },
  };
  return { prompt, calls, messages, closed: () => closed };
}
const localMysqlResponses = () => ['1', '2', 'localhost', '3306', 'reporting', 'mcp_reader', password, '2', 'reports', 'id,name'];

test('setup prompts for a hidden untrimmed password and saves only after confirmation', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-setup-prompt-'));
  const values = [...localMysqlResponses(), 'y'];
  values[4] = 'reporting-north';
  const mock = mockPrompt(values);
  try {
    const result = await runSetup(mock.prompt, dir, entrypoint, executable);
    assert.equal(values.length, 0); assert.equal(mock.calls[0].options?.defaultValue, '1'); assert.equal(mock.calls[1].options?.defaultValue, '1');
    assert.equal(mock.calls[6].options?.secret, true); assert.equal(mock.calls.filter(call => call.options?.secret).length, 1);
    assert.equal(mock.calls[7].options?.defaultValue, '1');
    const config = parseV2Config(JSON.parse(await readFile(result.configPath, 'utf8')));
    const source = config.sources[0]; if (source.engine !== 'mysql') throw new Error();
    assert.equal(source.database, 'reporting-north');
    assert.ok(source.passwordRef);
    assert.equal(await resolveSecret(source.passwordRef), password); assert.equal(config.instance.tier, 'read_only');
    assert.ok(!mock.messages.join('\n').includes(password)); assert.equal(mock.closed(), 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('MongoDB setup accepts blank answers for the default port, authentication database and confirmation', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-setup-mongo-defaults-'));
  const values = ['3', '2', 'localhost', '', 'reporting', 'mcp_reader', password, '2', 'reports', '_id,name', '', ''];
  const mock = mockPrompt(values);
  try {
    const result = await runSetup(mock.prompt, dir, entrypoint, executable);
    assert.equal(values.length, 0); assert.equal(mock.calls[3].options?.defaultValue, '27017');
    assert.equal(mock.calls[10].options?.defaultValue, 'reporting'); assert.equal(mock.calls[11].options?.defaultValue, 'y');
    const config = parseV2Config(JSON.parse(await readFile(result.configPath, 'utf8')));
    const source = config.sources[0]; if (source.engine !== 'mongodb') throw new Error();
    assert.ok(source.connectionStringRef);
    const uri = new URL(await resolveSecret(source.connectionStringRef));
    assert.equal(uri.port, '27017'); assert.equal(uri.searchParams.get('authSource'), 'reporting');
    assert.equal(decodeURIComponent(uri.password), password); assert.equal(config.instance.tier, 'read_only');
    assert.ok(!mock.messages.join('\n').includes(password)); assert.equal(mock.closed(), 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the default database setup skips object and prefix questions while retaining hidden passwords and privacy notice', async () => {
  for (const engine of ['mysql', 'redis', 'mongodb'] as const) {
    const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-setup-database-defaults-'));
    const values = [engine === 'mysql' ? '1' : engine === 'redis' ? '2' : '3', '2', 'localhost', '',
      engine === 'redis' ? '' : 'reporting', engine === 'redis' ? '' : 'mcp_reader', password, '', ...(engine === 'mongodb' ? [''] : []), ''];
    const mock = mockPrompt(values);
    try {
      const result = await runSetup(mock.prompt, dir, entrypoint, executable);
      assert.equal(values.length, 0); assert.equal(mock.calls.length, engine === 'mongodb' ? 10 : 9);
      assert.equal(mock.calls[6].options?.secret, true); assert.equal(mock.calls.filter(call => call.options?.secret).length, 1);
      assert.equal(mock.calls[7].options?.defaultValue, '1');
      assert.ok(!mock.calls.some(call => /允许读取的表|允许读取的集合|允许读取的字段|key 前缀/.test(call.label)));
      const config = parseV2Config(JSON.parse(await readFile(result.configPath, 'utf8'))), source = config.sources[0];
      assert.equal(config.instance.tier, 'read_only'); assert.equal(source.access.tier, 'read_only');
      assert.equal(Reflect.get(source.access, 'readScope'), 'database'); assert.equal(source.access.writes, undefined);
      if (source.engine === 'redis') {
        assert.equal(mock.calls[5].options?.defaultValue, 'default'); assert.equal(source.username, 'default');
        assert.equal(source.access.allowKeyspaceScan, false); assert.equal(source.database, 0);
      }
      assert.ok(mock.messages.join('\n').includes('敏感')); assert.ok(!mock.messages.join('\n').includes(password)); assert.equal(mock.closed(), 1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('setup cancellation or a rejected confirmation closes the prompt and writes no files', async () => {
  for (const earlyCancellation of [false, true]) {
    const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-setup-cancel-'));
    const mock = mockPrompt([...localMysqlResponses(), 'n'], earlyCancellation);
    try {
      await assert.rejects(runSetup(mock.prompt, dir, entrypoint, executable), error => {
        assert.ok(!String(error).includes(password)); assert.ok(!String(error).includes(dir)); return true;
      });
      assert.deepEqual(await readdir(dir), []); assert.equal(mock.closed(), 1);
      assert.ok(!mock.messages.join('\n').includes(password));
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('SSH setup stores separate private secrets and verifies references without contacting the server', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-setup-ssh-'));
  const fixture = await sshFixture({ port: 1 });
  try {
    for (const method of ['password', 'private_key'] as const) {
      const keyPath = path.join(dir, 'identity');
      await writeFile(keyPath, clientKey.private, { mode: 0o600 });
      const ssh: NonNullable<SetupAnswers['ssh']> = { host: fixture.config.host, port: fixture.config.port,
        username: fixture.config.username, hostKeySha256: fixture.config.hostKeySha256,
        auth: method === 'password' ? { method, password: 'fixture-ssh-password' } :
          { method, privateKeyFile: keyPath, passphrase: 'fixture-key-passphrase' } };
      const result = await saveSetup({ ...baseAnswers(), ssh }, dir, entrypoint, executable);
      const content = await readFile(result.configPath, 'utf8');
      const config = parseV2Config(JSON.parse(content)), sshConfig = config.sources[0].ssh!;
      assert.ok('hostKeySha256' in sshConfig);
      const auth = sshConfig.auth;
      assert.equal(auth.method, method);
      assert.ok(!content.includes('fixture-ssh-password')); assert.ok(!content.includes('fixture-key-passphrase'));
      const ref = auth.method === 'password' ? auth.passwordRef : auth.passphraseRef!;
      assert.equal((await stat(ref.slice(5))).mode & 0o777, 0o600);
      assert.equal(await resolveSecret(ref), method === 'password' ? 'fixture-ssh-password' : 'fixture-key-passphrase');
      assert.equal(config.sources[0].tls.mode, 'verify_identity');
      assert.equal(fixture.authAttempts(), 0); assert.equal(fixture.targets.length, 0);
    }
  } finally { await fixture.close(); await rm(dir, { recursive: true, force: true }); }
});

test('production setup offers SSH with hidden authentication and retains the database hostname', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-setup-ssh-prompt-'));
  const values = ['1', '1', '2', 'db.internal.example', '', 'reporting', 'reader', password, '', '',
    'bastion.example', '2', 'fixture-ssh-password', 'y'];
  const mock = mockPrompt(values);
  try {
    const result = await runSetup(mock.prompt, dir, entrypoint, executable);
    const config = parseV2Config(JSON.parse(await readFile(result.configPath, 'utf8')));
    const source = config.sources[0]; if (source.engine !== 'mysql') throw new Error();
    assert.equal(values.length, 0); assert.equal(source.host, 'db.internal.example');
    const passwordRef = 'file:' + path.join(path.dirname(result.configPath), 'ssh-password');
    assert.deepEqual(source.ssh, { host: 'bastion.example', passwordRef });
    assert.equal(await resolveSecret(passwordRef), 'fixture-ssh-password');
    assert.equal(mock.calls.filter(call => call.options?.secret).length, 2);
    assert.ok(mock.calls.findIndex(call => call.label.startsWith('连接方式')) < mock.calls.findIndex(call => call.label.startsWith('数据库地址')));
    assert.ok(mock.messages.join('').includes('SSH 服务器解析并访问'));
    assert.ok(!mock.messages.join('').includes('fixture-ssh-password'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('SSH wizard defaults to local keys and stores only the SSH alias', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-setup-ssh-key-'));
  const values = ['1', '1', '2', 'db.internal.example', '', 'reporting', 'reader', password, '', '',
    'reporting-bastion', '', 'y'];
  const mock = mockPrompt(values);
  try {
    const result = await runSetup(mock.prompt, dir, entrypoint, executable);
    const config = parseV2Config(JSON.parse(await readFile(result.configPath, 'utf8')));
    assert.deepEqual(config.sources[0].ssh, { host: 'reporting-bastion' });
    assert.equal(values.length, 0);
    assert.equal(mock.calls.filter(call => call.options?.secret).length, 1);
    assert.ok(!(await readdir(path.dirname(result.configPath))).some(filename => filename.startsWith('ssh-')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
