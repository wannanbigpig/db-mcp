import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-package-'));
try {
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const paths = new Set(pack.files.map(file => file.path));
  for (const filename of paths) {
    assert.ok(!/(^|\/)(tests|legacy|handlers|connectors|security|\.aitasks|\.env)(\/|$)|config-loader|config_local|config\.json$/.test(filename), 'Forbidden release path: ' + filename);
    const content = await readFile(filename, 'utf8');
    assert.ok(!['test-only-secret-never-echo', 'private-value', 'hidden-value'].some(secret => content.includes(secret)), 'Test secret in artifact: ' + filename);
    assert.ok(!/mongodb(?:\+srv)?:\/\/[^\s@/:]+:[^\s@]+@/.test(content), 'Credential-bearing URI in artifact: ' + filename);
    assert.ok(!/from\s+['"]zod\/v3['"]/.test(content), 'Legacy Zod runtime path in artifact: ' + filename);
    assert.ok(!/["'](?:password|passwd)["']\s*:\s*["'][^"']+["']/.test(content), 'Literal password in artifact: ' + filename);
  }
  const pending = ['dist/index.js'], visited = new Set();
  while (pending.length) {
    const filename = pending.pop(); if (visited.has(filename)) continue; visited.add(filename);
    assert.ok(paths.has(filename), 'Missing executable module: ' + filename);
    const content = await readFile(filename, 'utf8');
    for (const match of content.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(filename), match[1])));
  }
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', dir, path.join(dir, pack.filename)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const installedRoot = path.join(dir, 'node_modules', pack.name);
  const installedEntry = path.join(installedRoot, 'dist/index.js');
  const schemaPath = 'dist/config/config.schema.json';
  assert.ok(paths.has(schemaPath));
  assert.ok(!paths.has('config.schema.json') && !paths.has('examples/config.schema.json'));
  const installedSchema = JSON.parse(execFileSync(process.execPath, [installedEntry, '--print-config-schema'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.deepEqual(installedSchema, JSON.parse(await readFile(path.join(installedRoot, schemaPath), 'utf8')));
  const readExample = async filename => {
    assert.ok(paths.has(filename), 'Missing configuration example: ' + filename);
    const example = JSON.parse(await readFile(path.join(installedRoot, filename), 'utf8'));
    assert.equal(path.posix.join(path.posix.dirname(filename), example.$schema), schemaPath, 'Schema reference in ' + filename);
    return example;
  };
  await readExample('config.example.json');
  const config = path.join(dir, 'check.json');
  await writeFile(config, JSON.stringify({ version: 2, instance: { name: 'package-check', transport: 'stdio', environment: 'test', tier: 'read_only' },
    sources: [{ id: 'db', engine: 'mysql', host: '127.0.0.1', database: 'test', username: 'reader', passwordRef: 'env:DB_MCP_PACKAGE_TEST',
      tls: { mode: 'disabled' }, access: { tier: 'read_only', tables: ['reports'] } }] }));
  execFileSync(process.execPath, [installedEntry, '--config', config, '--check'], {
    env: { DB_MCP_PACKAGE_TEST: 'disposable-package-test-value' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const writeExample = await readExample('examples/config.write.example.json');
  writeExample.instance.journal.directory = dir;
  writeExample.sources[0].passwordRef = 'env:DB_MCP_PACKAGE_TEST';
  const writeConfig = path.join(dir, 'write-check.json');
  await writeFile(writeConfig, JSON.stringify(writeExample));
  execFileSync(process.execPath, [installedEntry, '--config', writeConfig, '--check'], {
    env: { DB_MCP_PACKAGE_TEST: 'disposable-package-test-value' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.ok(paths.has('dist/runtime/ssh-tunnel.js'));
  assert.ok(paths.has('dist/runtime/local-ssh-tunnel.js'));
  const { utils } = createRequire(installedEntry)('ssh2');
  const identity = utils.generateKeyPairSync('ed25519');
  const sshExample = await readExample('examples/config.ssh.example.json');
  sshExample.sources[0].passwordRef = 'env:DB_MCP_PACKAGE_TEST';
  const defaultSsh = sshExample.sources[0].ssh;
  const sshConfig = path.join(dir, 'ssh-check.json');
  for (const ssh of [defaultSsh, { ...defaultSsh, passwordRef: 'env:DB_MCP_PACKAGE_SSH_PASSWORD' },
    { ...defaultSsh, username: 'fixture', hostKeySha256: 'SHA256:' + 'A'.repeat(43),
      auth: { method: 'private_key', privateKeyRef: 'env:DB_MCP_PACKAGE_KEY' } }]) {
    sshExample.sources[0].ssh = ssh;
    await writeFile(sshConfig, JSON.stringify(sshExample));
    execFileSync(process.execPath, [installedEntry, '--config', sshConfig, '--check'], {
      env: { DB_MCP_PACKAGE_TEST: 'disposable-package-test-value', DB_MCP_PACKAGE_KEY: identity.private,
        DB_MCP_PACKAGE_SSH_PASSWORD: 'disposable-package-ssh-password' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  const { saveSetup } = await import(pathToFileURL(path.join(installedRoot, 'dist/config/setup.js')).href);
  const { parseV2Config } = await import(pathToFileURL(path.join(installedRoot, 'dist/config/v2.js')).href);
  const generated = await saveSetup({ engine: 'mysql', localDevelopment: true, host: 'localhost', port: 1,
    database: 'test', username: 'reader', password: 'disposable-package-test-value', objects: [{ name: 'reports', fields: ['name'] }] },
    path.join(dir, 'setup'), installedEntry);
  execFileSync(process.execPath, [installedEntry, '--config', generated.configPath, '--check'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const client = JSON.parse(await readFile(generated.clientConfigPath, 'utf8'));
  assert.deepEqual(client.mcpServers['db-mcp'].args, [installedEntry, '--config', generated.configPath]);
  assert.ok(!JSON.stringify(client).includes('disposable-package-test-value'));
  for (const engine of ['mysql', 'redis', 'mongodb']) {
    const profile = await saveSetup({ engine, localDevelopment: true, host: 'localhost', port: 1,
      ...(engine === 'redis' ? { redisDatabase: 0 } : { database: 'test', username: 'reader' }),
      password: 'disposable-package-test-value' }, path.join(dir, 'database-scope-' + engine), installedEntry);
    const saved = JSON.parse(await readFile(profile.configPath, 'utf8'));
    assert.deepEqual(saved.sources[0].access, {});
    assert.equal(saved.sources[0].budgets, undefined);
    const source = parseV2Config(saved).sources[0];
    assert.equal(source.access.readScope, 'database');
    assert.equal(source.access.tier, 'read_only');
    if (source.engine === 'redis') {
      assert.equal(source.username, 'default');
      assert.equal(source.access.allowKeyspaceScan, false);
    }
    execFileSync(process.execPath, [installedEntry, '--config', profile.configPath, '--check'], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  try {
    execFileSync(process.execPath, [installedEntry, '--setup'], { stdio: ['ignore', 'pipe', 'pipe'] });
    assert.fail('Piped setup must be rejected');
  } catch (error) {
    assert.equal(error.status, 1); assert.ok(String(error.stderr).includes('交互终端'));
  }
  process.stdout.write('Artifact whitelist, executable import graph, credential-pattern check, isolated install, read/write/SSH --check and allowlist/database setup profiles passed. Files: ' + paths.size + '\n');
} finally { await rm(dir, { recursive: true }); }
