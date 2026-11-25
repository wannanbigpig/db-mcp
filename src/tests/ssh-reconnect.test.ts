import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { sshFixture } from './helpers/ssh.js';

const local = '127.0.0.1';
const knownKey = 'fixture:known';
const writtenKey = 'fixture:written';

async function listen(server: Server): Promise<number> {
  server.listen(0, local);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

async function until<T>(observe: () => Promise<T> | T, ready: (value: T) => boolean, ms: number, description: string): Promise<T> {
  const deadline = performance.now() + ms;
  while (true) {
    const value = await observe();
    if (ready(value)) return value;
    assert.ok(performance.now() < deadline, `${description}. Last observation: ${JSON.stringify(value)}`);
    await wait(50);
  }
}

async function redisFixture(onWrite: () => void) {
  const peers = new Set<Socket>();
  const keys = new Map([[knownKey, 'initial']]);
  let writes = 0;
  const server = createServer(socket => {
    peers.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => peers.delete(socket));
    let pending = '';
    socket.on('data', chunk => {
      // These fixtures send ASCII RESP arrays only; a partial frame is saved for the next TCP chunk.
      const lines = (pending + chunk.toString('ascii')).split('\r\n');
      while (lines[0].startsWith('*')) {
        const frameLength = 1 + Number(lines[0].slice(1)) * 2;
        if (lines.length <= frameLength) break;
        const args = lines.splice(0, frameLength).filter((_, index) => index > 0 && index % 2 === 0);
        switch (args[0]) {
          case 'AUTH': socket.write('+OK\r\n'); break;
          case 'PING': socket.write('+PONG\r\n'); break;
          case 'INFO': socket.write('$17\r\nredis_version:7.0\r\n'); break;
          case 'TYPE': socket.write(keys.has(args[1]) ? '+string\r\n' : '+none\r\n'); break;
          case 'GETRANGE': {
            const value = keys.get(args[1]) ?? '';
            socket.write('$' + value.length + '\r\n' + value + '\r\n');
            break;
          }
          case 'EVAL':
            assert.equal(args[2], '1');
            assert.equal(args[3], writtenKey);
            assert.equal(args[4], 'create');
            keys.set(args[3], args[5]);
            writes++;
            // The network goes away after the simulated database has applied the write, before replying.
            onWrite();
            break;
          default: socket.write('-ERR unsupported fixture command\r\n');
        }
      }
      pending = lines.join('\r\n');
    });
  });
  const port = await listen(server);
  return {
    port, writes: () => writes,
    close: async () => {
      for (const peer of peers) peer.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

async function sshFaultProxy(upstream: number) {
  const pairs = new Set<{ client: Socket; server: Socket }>();
  let mode: 'online' | 'reset' | 'blackhole' = 'online';
  let blockedAttempts = 0, droppedBytes = 0;
  const listener = createServer(client => {
    client.on('error', () => {});
    if (mode === 'reset') { blockedAttempts++; client.resetAndDestroy(); return; }
    const server = createConnection(upstream, local);
    const pair = { client, server };
    pairs.add(pair);
    const close = () => { client.destroy(); server.destroy(); pairs.delete(pair); };
    server.on('error', close).once('close', close);
    client.once('close', close);
    const forward = (target: Socket) => (chunk: Buffer) => {
      if (mode === 'online') target.write(chunk);
      else droppedBytes += chunk.length;
    };
    client.on('data', forward(server));
    server.on('data', forward(client));
  });
  const port = await listen(listener);
  return {
    port, droppedBytes: () => droppedBytes, openPairs: () => pairs.size, blockedAttempts: () => blockedAttempts,
    reset: () => {
      mode = 'reset';
      for (const { client } of pairs) if (!client.destroyed) client.resetAndDestroy();
    },
    blackhole: () => { mode = 'blackhole'; },
    restore: () => { mode = 'online'; },
    close: async () => {
      for (const { client, server } of pairs) { client.destroy(); server.destroy(); }
      await new Promise<void>(resolve => listener.close(() => resolve()));
    },
  };
}

type Status = { id: string; status: string; errorCode?: string };
type ToolData = { sources?: Status[]; rows?: Array<{ key: string; value: string }>; operationId?: string;
  state?: string; code?: string; error?: { code: string } };

function fixtureTransport(filename: string): StdioClientTransport {
  const sourceRun = import.meta.url.endsWith('.ts');
  const entrypoint = fileURLToPath(new URL(sourceRun ? '../index.ts' : '../index.js', import.meta.url));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [...(sourceRun ? ['--import', 'tsx'] : []), entrypoint, '--config', filename],
    env: { DB_MCP_RECONNECT_REDIS_FIXTURE: 'fixture-redis-password', DB_MCP_SSH_FIXTURE: 'fixture-ssh-password', TSX_DISABLE_CACHE: '1' }, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  return transport;
}

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolData> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 4000 });
  const content = (result.content as Array<{ type: string; text: string }>)[0];
  assert.equal(content?.type, 'text');
  return JSON.parse(content.text) as ToolData;
}

async function exercise(scenario: 'reset' | 'blackhole'): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'db-mcp-ssh-reconnect-'));
  const filename = path.join(directory, 'v2.json');
  // The blackhole fixture needs no journal or write permissions.
  const writable = scenario === 'reset';
  let proxy: Awaited<ReturnType<typeof sshFaultProxy>> | undefined;
  const redis = await redisFixture(() => proxy!.reset());
  const ssh = await sshFixture({ port: redis.port });
  try {
    proxy = await sshFaultProxy(ssh.config.port);
    const redisSource = { engine: 'redis', host: local, port: redis.port, username: 'fixture-reader',
      passwordRef: 'env:DB_MCP_RECONNECT_REDIS_FIXTURE', tls: { mode: 'disabled' }, access: { keyPrefixes: ['fixture:'] },
      budgets: { connectTimeoutMs: 1000, queryTimeoutMs: 1500, maxConnections: 1, maxConcurrent: 1 } };
    const source = { ...redisSource, id: 'ssh_cache', ssh: { ...ssh.config, port: proxy.port }, ...(writable ? {
      access: { ...redisSource.access, tier: 'read_write', writes: { allowCreate: true } },
    } : {}) };
    const instance = { name: 'ssh-reconnect', transport: 'stdio', environment: 'test', ...(writable ? {
      tier: 'read_write', journal: { directory },
    } : {}) };
    await writeFile(filename, JSON.stringify({ version: 2, instance, sources: [source, { ...redisSource, id: 'direct_cache' }] }));

    const transport = fixtureTransport(filename);
    const client = new Client({ name: 'ssh-reconnection-fixture', version: '1.0.0' });
    const call = (name: string, args?: Record<string, unknown>) => callTool(client, name, args);
    const state = async () => (await call('list_sources')).sources?.find(entry => entry.id === 'ssh_cache');
    const read = (sourceId: string, key = knownKey) => call('redis_get', { sourceId, key });
    const value = (result: ToolData) => {
      assert.equal(result.error, undefined);
      assert.ok(result.rows?.[0]);
      return Buffer.from(result.rows[0].value, 'base64').toString();
    };
    try {
      await client.connect(transport, { timeout: 8000 });
      const pid = transport.pid;
      assert.ok(pid);
      assert.equal((await state())?.status, 'ready');
      assert.equal(value(await read('ssh_cache')), 'initial');
      assert.equal(proxy.openPairs(), 1);

      let writeArgs: { sourceId: string; operationId: string } | undefined;
      if (writable) {
        const write = await call('redis_prepare_write', { sourceId: 'ssh_cache', key: writtenKey, action: 'create', value: 'committed', ttl: { mode: 'clear' } });
        assert.ok(write.operationId, JSON.stringify(write));
        writeArgs = { sourceId: 'ssh_cache', operationId: write.operationId };
        const interrupted = await call('commit_write', writeArgs);
        assert.equal(interrupted.state, 'unknown_outcome');
        assert.equal(interrupted.code, 'WRITE_OUTCOME_UNKNOWN');
        assert.equal(redis.writes(), 1);
      } else {
        proxy.blackhole();
        // Let the real SSH keepalive fail the session. No Redis command runs during detection.
        await until(proxy.droppedBytes, bytes => bytes > 0, 12_000, 'the TCP proxy must observe an SSH keepalive');
        assert.equal(proxy.openPairs(), 1, 'dropping packets must leave the original TCP sockets open initially');
      }

      await until(state, value => value?.status === 'reconnecting', writable ? 3000 : 28_000, 'the affected source must reconnect');
      assert.ok((await read('ssh_cache')).error, 'database calls fail while the source is reconnecting');
      assert.equal(value(await read('direct_cache')), 'initial');
      if (writeArgs) {
        assert.equal((await call('operation_status', writeArgs)).state, 'unknown_outcome');
        await until(proxy.blockedAttempts, count => count >= 2, 4500, 'automatic reconnect must retry after a failed attempt');
      }

      proxy.restore();
      await until(state, value => value?.status === 'ready', 8500, 'the source must recover after the link returns');
      assert.equal(transport.pid, pid, 'the same db-mcp process serves the recovered source');
      assert.equal(value(await read('ssh_cache')), 'initial');
      assert.equal(proxy.openPairs(), 1, 'only the new SSH session should be open');
      if (writeArgs) {
        assert.equal((await call('operation_status', writeArgs)).state, 'unknown_outcome');
        assert.equal((await call('commit_write', writeArgs)).state, 'unknown_outcome');
        const later = await call('redis_prepare_write', { sourceId: 'ssh_cache', key: 'fixture:another', action: 'create', value: 'new', ttl: { mode: 'clear' } });
        assert.equal(later.error?.code, 'WRITE_OUTCOME_UNKNOWN');
        assert.equal(redis.writes(), 1, 'reconnect and repeated commit must not send a second write');
        assert.equal(value(await read('ssh_cache', writtenKey)), 'committed');
      }
    } finally { await client.close(); await transport.close(); }
  } finally {
    await proxy?.close();
    await ssh.close();
    await redis.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('real stdio serves a ready source while optional SSH authentication is still pending', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'db-mcp-ssh-startup-'));
  const filename = path.join(directory, 'v2.json');
  const redis = await redisFixture(() => assert.fail('read-only fixture received a write'));
  const ssh = await sshFixture({ port: redis.port }, { stall: true });
  try {
    const source = { engine: 'redis', host: local, port: redis.port, username: 'fixture-reader',
      passwordRef: 'env:DB_MCP_RECONNECT_REDIS_FIXTURE', tls: { mode: 'disabled' }, access: { keyPrefixes: ['fixture:'] } };
    const instance = { name: 'ssh-startup', transport: 'stdio', environment: 'test', budgets: { maxConnections: 2 } };
    await writeFile(filename, JSON.stringify({ version: 2, instance, sources: [
      { ...source, id: 'ssh_cache', required: false, ssh: ssh.config, budgets: { connectTimeoutMs: 30000 } },
      { ...source, id: 'direct_cache' },
    ] }));
    const client = new Client({ name: 'ssh-startup-fixture', version: '1.0.0' });
    const transport = fixtureTransport(filename);
    try {
      await client.connect(transport, { timeout: 6000 });
      await until(ssh.authAttempts, count => count > 0, 4000, 'background SSH authentication must have started');
      const { sources } = await callTool(client, 'list_sources');
      assert.deepEqual(sources?.map(({ status, errorCode }) => [status, errorCode]), [['reconnecting', undefined], ['ready', undefined]]);
      const result = await callTool(client, 'redis_get', { sourceId: 'direct_cache', key: knownKey });
      assert.equal(result.error, undefined);
      assert.equal(Buffer.from(result.rows![0].value, 'base64').toString(), 'initial');
      assert.equal(ssh.targets.length, 0);
    } finally { await client.close(); await transport.close(); }
  } finally {
    await ssh.close();
    await redis.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('real stdio recovers from an abrupt SSH reset without replaying a sent write', { timeout: 20_000 }, () => exercise('reset'));
test('real stdio detects an idle SSH blackhole and recovers without process restart', { timeout: 52_000 }, () => exercise('blackhole'));
