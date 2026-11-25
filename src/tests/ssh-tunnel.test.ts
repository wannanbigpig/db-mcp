import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, createConnection, type Socket } from 'node:net';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import ssh2, { type ClientChannel, type Connection } from 'ssh2';
import { SshTunnel, SshReadAdapter, sshCredentials } from '../runtime/ssh-tunnel.js';
import { clientKey, sshFixture } from './helpers/ssh.js';

async function stalledForwardFixture() {
  const key = ssh2.utils.generateKeyPairSync('ed25519');
  const parsed = ssh2.utils.parseKey(key.private);
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Fixture key failed');
  const peers = new Set<Connection>();
  let requested = () => {}, disconnected = () => {}, requests = 0;
  const forwardRequested = new Promise<void>(resolve => { requested = resolve; });
  const peerDisconnected = new Promise<void>(resolve => { disconnected = resolve; });
  const server = new ssh2.Server({ hostKeys: [key.private] }, peer => {
    peers.add(peer); peer.on('error', () => {});
    peer.once('close', () => { peers.delete(peer); disconnected(); });
    peer.on('authentication', context => context.accept());
    // A healthy SSH connection may wait indefinitely for the target's TCP/DNS result.
    peer.on('tcpip', () => { requests++; requested(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error();
  return {
    config: { host: '127.0.0.1', port: address.port, username: 'fixture',
      hostKeySha256: 'SHA256:' + createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, ''),
      auth: { method: 'password' as const, passwordRef: 'env:UNUSED_FIXTURE' } },
    forwardRequested, peerDisconnected, requests: () => requests,
    close: async () => {
      for (const peer of peers) peer.end();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

async function echo(payload?: Buffer) {
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
    if (payload) socket.write(payload); else socket.pipe(socket);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error();
  return { port: address.port, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('real SSH password tunnel forwards only the fixed target, limits sockets and closes its listener', { timeout: 10000 }, async () => {
  const upstream = await echo(), fixture = await sshFixture(upstream);
  const tunnel = new SshTunnel(fixture.config, { host: 'private-db.example', port: 3306 }, { password: 'fixture-ssh-password' }, 2000, 1);
  const sockets: Socket[] = [];
  try {
    const endpoint = await tunnel.connect(); assert.equal(endpoint.host, '127.0.0.1');
    const socket = createConnection(endpoint); sockets.push(socket); socket.on('error', () => {});
    socket.write('fixture-payload');
    assert.equal((await once(socket, 'data'))[0].toString(), 'fixture-payload');
    assert.equal(fixture.targets.length, 1); assert.equal(fixture.targets[0].destIP, 'private-db.example'); assert.equal(fixture.targets[0].destPort, 3306);
    const excess = createConnection(endpoint); sockets.push(excess); excess.on('error', () => {});
    await once(excess, 'close'); assert.equal(fixture.targets.length, 1);
    const closed = once(socket, 'close'); await tunnel.close(); await closed; await tunnel.close();
    const refused = createConnection(endpoint); sockets.push(refused);
    const [error] = await once(refused, 'error'); assert.equal(error.code, 'ECONNREFUSED');
  } finally { for (const socket of sockets) socket.destroy(); await tunnel.close(); await fixture.close(); await upstream.close(); }
});

for (const buffered of [false, true]) {
  test('SSH channel is released after local close with ' + (buffered ? 'unread data' : 'only consumed data'), { timeout: 10000 }, async () => {
    const upstream = await echo(buffered ? Buffer.alloc(8 * 1024 * 1024) : undefined);
    const fixture = await sshFixture(upstream);
    const tunnel = new SshTunnel(fixture.config, { host: 'private-db.example', port: 3306 }, { password: 'fixture-ssh-password' }, 2000, 1);
    const tracked = Reflect.get(tunnel, 'channels') as Set<ClientChannel>;
    const until = async (ready: () => boolean) => {
      for (let attempt = 0; attempt < 100 && !ready(); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(ready());
    };
    let socket: Socket | undefined;
    try {
      const endpoint = await tunnel.connect();
      for (let attempt = 0; attempt < 3; attempt++) {
        socket = createConnection(endpoint); socket.on('error', () => {});
        if (buffered) {
          await until(() => [...tracked].some(channel => channel.readableLength > 0));
        } else {
          socket.write('fixture');
          assert.equal((await once(socket, 'data'))[0].toString(), 'fixture');
        }
        assert.equal(tracked.size, 1);
        const closed = once(socket, 'close');
        socket.destroy();
        await closed;
        await until(() => tracked.size === 0);
      }
      assert.equal(fixture.targets.length, 3);
    } finally { socket?.destroy(); await tunnel.close(); await fixture.close(); await upstream.close(); }
  });
}

test('a local connection can wait for the previous SSH channel to close without exceeding the forward limit', { timeout: 10000 }, async () => {
  const upstream = await echo(), fixture = await sshFixture(upstream);
  const tunnel = new SshTunnel(fixture.config, { host: 'private-db.example', port: 3306 }, { password: 'fixture-ssh-password' }, 2000, 1);
  const sockets: Socket[] = [];
  try {
    const endpoint = await tunnel.connect();
    const first = createConnection(endpoint); sockets.push(first); first.on('error', () => {});
    first.write('first');
    assert.equal((await once(first, 'data'))[0].toString(), 'first');
    const next = createConnection(endpoint); sockets.push(next); next.on('error', () => {});
    const reply = once(next, 'data');
    const closed = once(next, 'close');
    next.write('next');
    await once(next, 'connect');
    assert.equal(fixture.targets.length, 1);
    first.destroy();
    assert.equal(await Promise.race([reply.then(([data]) => data.toString()), closed.then(() => 'closed')]), 'next');
    assert.equal(fixture.targets.length, 2);
  } finally { for (const socket of sockets) socket.destroy(); await tunnel.close(); await fixture.close(); await upstream.close(); }
});

test('host pin mismatch rejects before authentication and never forwards a connection', { timeout: 10000 }, async () => {
  const fixture = await sshFixture({ port: 1 });
  const tunnel = new SshTunnel({ ...fixture.config, hostKeySha256: 'SHA256:' + Buffer.alloc(32).toString('base64').replace(/=+$/, '') },
    { host: 'private-db.example', port: 3306 }, { password: 'fixture-ssh-password' }, 1000, 1);
  try {
    await assert.rejects(tunnel.connect(), { code: 'SSH_HOST_KEY_MISMATCH' });
    assert.equal(fixture.authAttempts(), 0); assert.equal(fixture.targets.length, 0);
  } finally { await tunnel.close(); await fixture.close(); }
});

test('wrong SSH credentials, deadline and shutdown during authentication fail safely', { timeout: 10000 }, async () => {
  for (const mode of ['password', 'deadline', 'shutdown']) {
    const fixture = await sshFixture({ port: 1 }, { stall: mode !== 'password' });
    const tunnel = new SshTunnel(fixture.config, { host: 'private-db.example', port: 3306 }, { password: 'incorrect-fixture' }, mode === 'deadline' ? 150 : 2000, 1);
    try {
      const pending = assert.rejects(tunnel.connect(), { code: mode === 'password' ? 'SSH_AUTH_FAILED' : 'SSH_UNAVAILABLE' });
      if (mode === 'shutdown') await tunnel.close();
      await pending; assert.equal(fixture.targets.length, 0);
    } finally { await tunnel.close(); await fixture.close(); }
  }
});

test('encrypted private keys authenticate through references; invalid keys fail offline', { timeout: 10000 }, async () => {
  const fixture = await sshFixture({ port: 1 });
  process.env.DB_MCP_SSH_KEY_FIXTURE = clientKey.private; process.env.DB_MCP_SSH_PASSPHRASE_FIXTURE = 'fixture-key-passphrase';
  const config = { ...fixture.config, auth: { method: 'private_key' as const, privateKeyRef: 'env:DB_MCP_SSH_KEY_FIXTURE', passphraseRef: 'env:DB_MCP_SSH_PASSPHRASE_FIXTURE' } };
  let tunnel: SshTunnel | undefined;
  try {
    tunnel = new SshTunnel(config, { host: 'private-db.example', port: 3306 }, await sshCredentials(config), 2000, 1);
    await tunnel.connect(); assert.ok(fixture.authAttempts() > 0);
    process.env.DB_MCP_SSH_PASSPHRASE_FIXTURE = 'wrong-fixture';
    await assert.rejects(sshCredentials(config), { code: 'INVALID_CONFIG' });
    process.env.DB_MCP_SSH_KEY_FIXTURE = clientKey.public;
    await assert.rejects(sshCredentials(config), { code: 'INVALID_CONFIG' });
  } finally { delete process.env.DB_MCP_SSH_KEY_FIXTURE; delete process.env.DB_MCP_SSH_PASSPHRASE_FIXTURE; await tunnel?.close(); await fixture.close(); }
});

test('a forwarding rejection closes only that socket without retrying or leaking the listener', { timeout: 10000 }, async () => {
  const fixture = await sshFixture({ port: 1 }, { rejectForward: true });
  const tunnel = new SshTunnel(fixture.config, { host: 'private-db.example', port: 3306 }, { password: 'fixture-ssh-password' }, 1000, 1);
  let socket: Socket | undefined;
  try {
    socket = createConnection(await tunnel.connect()); socket.on('error', () => {});
    await once(socket, 'close'); assert.equal(fixture.targets.length, 1);
  } finally { socket?.destroy(); await tunnel.close(); await fixture.close(); }
});

for (const reason of ['deadline', 'caller cancellation'] as const) {
  test('unfinished SSH channel opening closes the session on ' + reason, { timeout: 10000 }, async () => {
    const fixture = await stalledForwardFixture();
    const tunnel = new SshTunnel(fixture.config, { host: 'private-db.example', port: 3306 }, { password: 'fixture' }, 500, 1);
    let socket: Socket | undefined;
    let disconnects = 0;
    let disconnected = () => {};
    const unavailable = new Promise<void>(resolve => { disconnected = resolve; });
    tunnel.onDisconnect = () => { disconnects++; disconnected(); };
    let deadline: NodeJS.Timeout | undefined;
    try {
      const endpoint = await tunnel.connect();
      socket = createConnection(endpoint); socket.on('error', () => {});
      const closed = once(socket, 'close');
      await fixture.forwardRequested;
      if (reason === 'caller cancellation') socket.destroy();
      await closed;
      // A paused local socket may observe FIN only after reading resumes. Its
      // slot must stay occupied until the bounded opening deadline closes SSH.
      await Promise.race([unavailable, new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('abandoned SSH forward remained reusable')), 1500);
      })]);
      assert.equal(disconnects, 1, 'an abandoned forward must invalidate the session, not free a reusable slot');
      await fixture.peerDisconnected;
      const refused = createConnection(endpoint);
      const [error] = await once(refused, 'error');
      assert.equal(error.code, 'ECONNREFUSED');
      assert.equal(fixture.requests(), 1, 'no subsequent forward may accumulate behind the abandoned one');
    } finally { clearTimeout(deadline); socket?.destroy(); await tunnel.close(); await fixture.close(); }
  });
}

test('SSH disconnect makes the wrapped source unavailable and closes its database adapter', { timeout: 10000 }, async () => {
  const fixture = await sshFixture({ port: 1 });
  const tunnel = new SshTunnel(fixture.config, { host: 'private-db.example', port: 3306 }, { password: 'fixture-ssh-password' }, 2000, 1);
  let markDatabaseClosed = () => {};
  const databaseClosed = new Promise<void>(resolve => { markDatabaseClosed = resolve; });
  const adapter = new SshReadAdapter(tunnel, () => ({ connect: async () => {}, close: async () => { markDatabaseClosed(); }, async *read() { yield 'fixture'; } }));
  const unavailable = new Promise<string>(resolve => adapter.onUnavailable(resolve));
  try {
    await adapter.connect(); fixture.disconnect(); assert.equal(await unavailable, 'SSH_UNAVAILABLE');
    await databaseClosed;
    await assert.rejects(async () => { for await (const _ of adapter.read({ tool: 'mysql_list_tables', limit: 1 }, new AbortController().signal)) {} }, { code: 'SOURCE_UNAVAILABLE' });
  } finally { await adapter.close(); await fixture.close(); }
});

test('concurrent SSH adapter close calls await the same complete database cleanup', { timeout: 10000 }, async () => {
  const fixture = await sshFixture({ port: 1 });
  const tunnel = new SshTunnel(fixture.config, { host: 'private-db.example', port: 3306 }, { password: 'fixture-ssh-password' }, 2000, 1);
  let release: () => void = () => {}, started: () => void = () => {}, closes = 0, settled = false;
  const cleaning = new Promise<void>(resolve => { started = resolve; });
  const cleaned = new Promise<void>(resolve => { release = resolve; });
  const adapter = new SshReadAdapter(tunnel, () => ({ connect: async () => {}, async *read() {},
    close: async () => { closes++; started(); await cleaned; } }));
  try {
    await adapter.connect(); const first = adapter.close();
    assert.equal(adapter.close(), first);
    void first.then(() => { settled = true; });
    await cleaning; assert.equal(settled, false); assert.equal(closes, 1);
    release(); await first; assert.equal(settled, true);
  } finally { release(); await adapter.close(); await fixture.close(); }
});
