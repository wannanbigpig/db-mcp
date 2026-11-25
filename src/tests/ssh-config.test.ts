import test from 'node:test';
import assert from 'node:assert/strict';
import { parseV2Config, type SshConfig } from '../config/v2.js';
import { createAdapterFactory, createReadAdapter } from '../runtime/adapters.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { sshFixture } from './helpers/ssh.js';
import { SourceRegistry } from '../runtime/sources.js';

const ssh = { host: 'bastion.example', username: 'tunnel', hostKeySha256: 'SHA256:' + Buffer.alloc(32).toString('base64').replace(/=+$/, ''),
  auth: { method: 'password', passwordRef: 'env:DB_MCP_SSH_CONFIG_TEST' } };
const input = () => ({ version: 2, instance: { name: 'ssh-test', environment: 'production', transport: 'stdio' }, sources: [{
  id: 'mysql', engine: 'mysql', host: 'db.internal.example', database: 'reporting', username: 'reader',
  passwordRef: 'env:DB_MCP_SSH_CONFIG_TEST', tls: { mode: 'verify_identity' }, access: {}, ssh: structuredClone(ssh),
}] });
const mongoConfig = (ssh: SshConfig) => parseV2Config({ ...input(), sources: [{ id: 'mongo', engine: 'mongodb', database: 'reporting',
  connectionStringRef: 'env:DB_MCP_MONGO_SSH_CONFIG_TEST', tls: { mode: 'verify_identity' }, access: {},
  ssh, budgets: { connectTimeoutMs: 350 } }] });

test('SSH is optional and preserves the fixed database and read-only defaults', () => {
  const config = parseV2Config(input());
  const value = config.sources[0].ssh!;
  assert.ok('hostKeySha256' in value);
  assert.equal(value.port, 22);
  assert.equal(config.sources[0].access.tier, 'read_only');
  assert.ok(Object.isFrozen(value.auth));
  const direct = input(); Reflect.deleteProperty(direct.sources[0], 'ssh');
  assert.equal(Reflect.get(parseV2Config(direct).sources[0], 'ssh'), undefined);
});

test('SSH rejects missing host pins, inline secrets, ambiguous auth and dynamic forwarding settings', () => {
  const variants: unknown[] = [
    { ...ssh, hostKeySha256: undefined }, { ...ssh, hostKeySha256: 'SHA256:invalid' },
    { ...ssh, host: 'host\nmalicious' }, { ...ssh, port: 0 }, { ...ssh, username: '' },
    { ...ssh, auth: { method: 'password', password: 'inline-fixture' } },
    { ...ssh, auth: { method: 'private_key', privateKeyRef: 'relative-path' } },
    { ...ssh, auth: { ...ssh.auth, privateKeyRef: 'env:KEY' } },
    { ...ssh, localHost: '0.0.0.0' }, { ...ssh, targetHost: 'other.example' },
    { host: '-F' }, { host: 'tunnel@bastion.example' }, { host: 'bastion.example', password: 'inline-fixture' },
    { host: 'bastion.example', username: 'legacy-with-missing-pin' },
  ];
  for (const value of variants) {
    const candidate = input(); Reflect.set(candidate.sources[0], 'ssh', value);
    assert.throws(() => parseV2Config(candidate), { code: 'INVALID_CONFIG' });
  }
});

test('a read-only SSH source preserves its explicitly chosen database TLS mode and host pin', () => {
  const candidate = input(); Reflect.set(candidate.sources[0], 'tls', { mode: 'disabled' });
  const source = parseV2Config(candidate).sources[0];
  assert.equal(source.tls.mode, 'disabled');
  assert.ok(source.ssh && 'hostKeySha256' in source.ssh);
  assert.equal(source.ssh.hostKeySha256, ssh.hostKeySha256);
});

test('SSH adapter creation and close stay offline, while still validating secret references', async () => {
  process.env.DB_MCP_SSH_CONFIG_TEST = 'fixture-only-value';
  try {
    const config = parseV2Config(input());
    const adapter = await createReadAdapter(config.sources[0], config);
    await adapter.close(); await adapter.close();
    delete process.env.DB_MCP_SSH_CONFIG_TEST;
    await assert.rejects(createReadAdapter(config.sources[0], config), { code: 'SECRET_UNAVAILABLE' });
  } finally { delete process.env.DB_MCP_SSH_CONFIG_TEST; }
});

test('MongoDB SSH targets retain the URI host and explicit port', { timeout: 10000 }, async () => {
  const fixture = await sshFixture({ port: 1 }, { rejectForward: true });
  process.env.DB_MCP_SSH_FIXTURE = 'fixture-ssh-password';
  try {
    const config = mongoConfig(fixture.config);
    for (const [address, host, port] of [
      ['private-db.example:80', 'private-db.example', 80], ['private-db.example', 'private-db.example', 27017],
      ['private-db.example:32100', 'private-db.example', 32100], ['[2001:db8::1]:80', '2001:db8::1', 80],
    ] as const) {
      process.env.DB_MCP_MONGO_SSH_CONFIG_TEST = 'mongodb://fixture:value@' + address + '/reporting';
      const adapter = await createReadAdapter(config.sources[0], config);
      try {
        await assert.rejects(adapter.connect());
        const actual = fixture.targets.at(-1);
        assert.ok(actual);
        assert.deepEqual([actual.destIP, actual.destPort], [host, port]);
      } finally { await adapter.close(); }
    }
  } finally { delete process.env.DB_MCP_SSH_FIXTURE; delete process.env.DB_MCP_MONGO_SSH_CONFIG_TEST; await fixture.close(); }
});

test('MongoDB SSH validates the driver URI without connecting to the SSH server', async () => {
  const fixture = await sshFixture({ port: 1 });
  process.env.DB_MCP_SSH_FIXTURE = 'fixture-ssh-password';
  try {
    const config = mongoConfig(fixture.config);
    for (const invalid of ['private-db.example:0/reporting', 'private-db.example/reporting?authSource=']) {
      process.env.DB_MCP_MONGO_SSH_CONFIG_TEST = 'mongodb://fixture:value@' + invalid;
      await assert.rejects(createReadAdapter(config.sources[0], config), { code: 'INVALID_CONFIG' });
    }
    assert.equal(fixture.authAttempts(), 0);
    assert.equal(fixture.targets.length, 0);
  } finally { delete process.env.DB_MCP_SSH_FIXTURE; delete process.env.DB_MCP_MONGO_SSH_CONFIG_TEST; await fixture.close(); }
});

test('SSH reconnect keeps the initial MongoDB endpoint until the service factory is recreated', { timeout: 10000 }, async () => {
  const fixture = await sshFixture({ port: 1 }, { rejectForward: true });
  const factory = createAdapterFactory();
  process.env.DB_MCP_SSH_FIXTURE = 'fixture-ssh-password';
  try {
    const config = mongoConfig(fixture.config);
    for (const [build, uriAddress, host, port] of [
      [factory, 'first.example:80', 'first.example', 80],
      [factory, 'second.example:32100', 'first.example', 80],
      [createAdapterFactory(), 'second.example:32100', 'second.example', 32100],
    ] as const) {
      process.env.DB_MCP_MONGO_SSH_CONFIG_TEST = 'mongodb://fixture:value@' + uriAddress + '/reporting';
      const adapter = await build(config.sources[0], config);
      try {
        await assert.rejects(adapter.connect());
        const actual = fixture.targets.at(-1);
        assert.ok(actual);
        assert.deepEqual([actual.destIP, actual.destPort], [host, port]);
      } finally { await adapter.close(); }
    }
  } finally { delete process.env.DB_MCP_SSH_FIXTURE; delete process.env.DB_MCP_MONGO_SSH_CONFIG_TEST; await fixture.close(); }
});

test('real --check validates SSH references without opening SSH and emits no secrets', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-ssh-check-'));
  const fixture = await sshFixture({ port: 1 });
  try {
    const candidate = input(); Reflect.set(candidate.sources[0], 'ssh', fixture.config);
    const filename = path.join(dir, 'config.json'); await writeFile(filename, JSON.stringify(candidate));
    const result = await promisify(execFile)(process.execPath, [path.resolve('dist/index.js'), '--config', filename, '--check'], {
      env: { ...process.env, DB_MCP_SSH_FIXTURE: 'fixture-ssh-password', DB_MCP_SSH_CONFIG_TEST: 'fixture-only-database-secret' }, timeout: 5000,
    });
    assert.equal(result.stdout, ''); assert.match(result.stderr, /CONFIG_VALID/);
    assert.ok(!result.stderr.includes('fixture-ssh-password')); assert.ok(!result.stderr.includes('fixture-only-database-secret'));
    assert.equal(fixture.authAttempts(), 0); assert.equal(fixture.targets.length, 0);
  } finally { await fixture.close(); await rm(dir, { recursive: true, force: true }); }
});

test('required SSH failure closes prior sources; optional failure remains sanitized and never forwards', { timeout: 10000 }, async () => {
  process.env.DB_MCP_SSH_CONFIG_TEST = 'fixture-only-value';
  process.env.DB_MCP_SSH_FIXTURE = 'fixture-ssh-password';
  try {
    for (const required of [true, false]) {
      const fixture = await sshFixture({ port: 1 });
      const candidate = input();
      Reflect.set(candidate.sources[0], 'ssh', { ...fixture.config, hostKeySha256: ssh.hostKeySha256 });
      Reflect.set(candidate.sources[0], 'required', required);
      const first = { ...candidate.sources[0], id: 'first' }; Reflect.deleteProperty(first, 'ssh');
      const config = parseV2Config({ ...candidate, sources: [first, ...candidate.sources] });
      let closed = false;
      const registry = new SourceRegistry(config, async (source, config) => source.id === 'first' ?
        { connect: async () => {}, close: async () => { closed = true; }, async *read() {} } : createReadAdapter(source, config));
      try {
        if (required) { await assert.rejects(registry.initialize(), { code: 'SSH_HOST_KEY_MISMATCH' }); assert.equal(closed, true); }
        else {
          await registry.initialize(); assert.equal(closed, false);
          assert.equal(registry.list()[0].status, 'ready');
          const deadline = Date.now() + 2500;
          while (registry.list()[1].status === 'reconnecting' && Date.now() < deadline) await wait(5);
          assert.deepEqual(registry.list()[1], { id: 'mysql', engine: 'mysql', purpose: '', status: 'unavailable', errorCode: 'SSH_HOST_KEY_MISMATCH' });
        }
        assert.equal(fixture.targets.length, 0); assert.equal(fixture.authAttempts(), 0);
      } finally { await registry.close(); await fixture.close(); }
    }
  } finally { delete process.env.DB_MCP_SSH_CONFIG_TEST; delete process.env.DB_MCP_SSH_FIXTURE; }
});
