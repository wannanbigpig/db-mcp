import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import path from 'node:path';
import { LocalSshTunnel } from '../runtime/local-ssh-tunnel.js';
import { localClientKey, sshFixture } from './helpers/ssh.js';

const nativeSsh = process.platform !== 'win32' && /OpenSSH/.test(
  spawnSync(process.platform === 'darwin' ? '/usr/bin/ssh' : 'ssh', ['-V'], { encoding: 'utf8' }).stderr ?? '');

test('native SSH reads an alias, verifies known_hosts and uses local key or referenced password', {
  skip: nativeSsh ? false : 'OpenSSH client unavailable', timeout: 20000,
}, async () => {
  const directory = await mkdtemp('/tmp/dbm-ssh-test-');
  const echo = createServer(socket => socket.pipe(socket));
  echo.listen(0, '127.0.0.1');
  await once(echo, 'listening');
  const address = echo.address();
  assert.ok(address && typeof address !== 'string');
  const fixture = await sshFixture({ port: address.port });
  try {
    const configFile = path.join(directory, 'config');
    const keyFile = path.join(directory, 'identity');
    const knownHosts = path.join(directory, 'known_hosts');
    const unwanted = path.join(directory, 'unwanted');
    await writeFile(keyFile, localClientKey.private.trimEnd() + '\n', { mode: 0o600 });
    await writeFile(configFile, [
      'Host reports-bastion', '  HostName 127.0.0.1', '  User tunnel', '  Port ' + fixture.config.port,
      '  IdentitiesOnly yes', '  IdentityFile ' + keyFile, '  GlobalKnownHostsFile /dev/null',
      '  UserKnownHostsFile ' + knownHosts, '  LocalForward ' + unwanted + ' 127.0.0.1:1',
    ].join('\n') + '\n', { mode: 0o600 });
    const target = { host: 'db.internal.example', port: 3306 };
    const create = (password?: string) => new LocalSshTunnel('reports-bastion', target, 3000, 2, { configFile, password });
    const untrusted = create();
    try {
      await assert.rejects(untrusted.connect(), { code: 'SSH_HOST_KEY_MISMATCH' });
      assert.equal(fixture.authAttempts(), 0);
    } finally { await untrusted.close(); }
    await writeFile(knownHosts, '[127.0.0.1]:' + fixture.config.port + ' ' + fixture.hostPublicKey.trim() + '\n');
    for (const password of [undefined, 'fixture-ssh-password']) {
      const tunnel = create(password);
      try {
        const endpoint = await tunnel.connect();
        await assert.rejects(readFile(unwanted), { code: 'ENOENT' });
        const socket = createConnection(endpoint);
        try {
          await once(socket, 'connect');
          socket.write('test payload');
          const [data] = await once(socket, 'data');
          assert.equal(String(data), 'test payload');
          assert.equal(fixture.targets.at(-1)?.destIP, target.host);
          assert.equal(fixture.targets.at(-1)?.destPort, target.port);
        } finally { socket.destroy(); }
        const lost = new Promise<string>(resolve => { tunnel.onDisconnect = resolve; });
        fixture.disconnect();
        assert.equal(await lost, 'SSH_UNAVAILABLE');
      } finally { await tunnel.close(); }
    }
    const rejected = create('bad-fixture-password');
    try { await assert.rejects(rejected.connect(), { code: 'SSH_AUTH_FAILED' }); }
    finally { await rejected.close(); }
  } finally {
    await fixture.close();
    await new Promise<void>(resolve => echo.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
