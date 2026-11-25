import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseV2Config } from '../config/v2.js';
import { RedisReadAdapter } from '../runtime/adapters/redis.js';
import { Dispatcher } from '../runtime/dispatcher.js';
import { OperationJournal } from '../runtime/journal.js';
import { Operations } from '../runtime/operations.js';
import { SourceRegistry } from '../runtime/sources.js';

test('Redis commits preserve definite ACL rejections and keep unrecognized errors unknown', { timeout: 5000 }, async t => {
  const replies = [
    "-NOPERM User private-fixture-detail has no permissions to run the 'eval' command",
    "-ERR ACL failure in script: User private-fixture-detail has no permissions to run the 'set' command",
    "-ERR The user executing the script can't run this command or subcommand",
    '-ERR unexpected script error with a NOPERM detail',
  ];
  const peers = new Set<Socket>();
  let evals = 0;
  const server = createServer(socket => {
    peers.add(socket);
    socket.on('error', () => {}).once('close', () => peers.delete(socket));
    let pending = '';
    socket.on('data', chunk => {
      // Commands and values in this fixture are ASCII and contain no CRLF.
      const lines = (pending + chunk.toString('ascii')).split('\r\n');
      while (lines[0].startsWith('*')) {
        const frameLength = 1 + 2 * Number(lines[0].slice(1));
        if (lines.length <= frameLength) break;
        const command = lines[2];
        lines.splice(0, frameLength);
        switch (command) {
          case 'AUTH': socket.write('+OK\r\n'); break;
          case 'PING': socket.write('+PONG\r\n'); break;
          case 'INFO': socket.write('$17\r\nredis_version:7.2\r\n'); break;
          case 'TYPE': socket.write('+none\r\n'); break;
          case 'EVAL': socket.write((replies[evals++] ?? '-ERR unexpected extra EVAL') + '\r\n'); break;
          default: socket.write('-ERR unsupported fixture command\r\n');
        }
      }
      pending = lines.join('\r\n');
    });
  });
  const directory = await mkdtemp(path.join(tmpdir(), 'db-mcp-redis-write-outcome-'));
  let registry: SourceRegistry | undefined;
  let operations: Operations | undefined;
  t.after(async () => {
    try {
      if (operations) await operations.stop(); else await registry?.close();
    } finally {
      for (const peer of peers) peer.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const config = parseV2Config({
    version: 2,
    instance: { name: 'redis-write-outcome', transport: 'stdio', environment: 'test', tier: 'read_write', journal: { directory } },
    sources: [{ id: 'cache', engine: 'redis', host: '127.0.0.1', port: address.port, username: 'writer',
      passwordRef: 'env:UNUSED_REDIS_FIXTURE', tls: { mode: 'disabled' },
      access: { tier: 'read_write', keyPrefixes: ['fixture:'], writes: { allowCreate: true } } }],
  });
  const source = config.sources[0];
  assert.equal(source.engine, 'redis');
  const adapter = new RedisReadAdapter(source, 'disposable-fixture');
  registry = new SourceRegistry(config, async () => adapter);
  await registry.initialize();
  const journal = await OperationJournal.open(config.instance.journal!, config.instance.name);
  operations = new Operations(registry, journal);
  const dispatcher = new Dispatcher(registry, () => {}, operations);
  const call = async (tool: string, args: Record<string, unknown>) => {
    const result = await dispatcher.call(tool, { sourceId: 'cache', ...args });
    assert.doesNotMatch(result.content[0].text, /private-fixture-detail/);
    return JSON.parse(result.content[0].text);
  };
  const prepare = () => call('redis_prepare_write', { key: 'fixture:key', action: 'create', value: 'next', ttl: { mode: 'clear' } });

  for (const [index, reply] of replies.entries()) {
    const { operationId } = await prepare();
    assert.ok(operationId, 'a previous known rejection must not block a new preview');
    const args = { operationId };
    const result = await call('commit_write', args);
    const definite = index < replies.length - 1;
    assert.equal(result.state, definite ? 'failed' : 'unknown_outcome', reply);
    assert.equal(result.code, definite ? 'WRITE_REJECTED' : 'WRITE_OUTCOME_UNKNOWN');
    assert.equal(result.directAffected, definite ? 0 : undefined);
    assert.equal(journal.hasUnknown('cache'), !definite);
    assert.deepEqual(await call('operation_status', args), result);
    assert.deepEqual(await call('commit_write', args), result);
    assert.equal(evals, index + 1, 'the same operation must never send EVAL twice');
  }
  assert.equal((await prepare()).error.code, 'WRITE_OUTCOME_UNKNOWN');
  assert.equal(registry.list()[0].status, 'ready');
});
