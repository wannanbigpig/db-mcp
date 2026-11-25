import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { sourceConnectionLimit, type SourceConfig, type V2Config } from '../config/v2.js';
import { resolveSecret } from '../config/secrets.js';
import type { AdapterFactory, ReadAdapter } from './sources.js';
import { SafeError } from './errors.js';
import { SshTunnel, SshReadAdapter, sshCredentials, type TunnelEndpoint } from './ssh-tunnel.js';
import { LocalSshTunnel } from './local-ssh-tunnel.js';
import { MysqlReadAdapter } from './adapters/mysql.js';
import { RedisReadAdapter } from './adapters/redis.js';
import { MongoReadAdapter, validateMongoTarget, validateMongoURI } from './adapters/mongodb.js';

// Stable adapter entry point. Engine modules own their client and read/write lifecycle.
export { MysqlReadAdapter, RedisReadAdapter, MongoReadAdapter, validateMongoURI };

export async function readCAFile(filename: string): Promise<Buffer> {
  try {
    // Open without waiting for a FIFO writer, then inspect the opened file. CA bundles
    // may use symlinks, but the file they resolve to must be regular and bounded.
    const handle = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error();
      const contents = Buffer.allocUnsafe(info.size + 1);
      let total = 0;
      while (total < contents.length) {
        const { bytesRead } = await handle.read(contents, total, contents.length - total, null);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total !== info.size) throw new Error();
      return contents.subarray(0, total);
    } finally { await handle.close(); }
  } catch { throw new SafeError('INVALID_CONFIG'); }
}

async function prepareAdapter(source: SourceConfig, config: V2Config): Promise<() => ReadAdapter> {
  const ca = source.tls.mode === 'verify_identity' && source.tls.caFile ? await readCAFile(source.tls.caFile) : undefined;
  const secret = source.engine === 'mongodb' ?
    source.connectionString ?? await resolveSecret(source.connectionStringRef!) :
    source.password ?? await resolveSecret(source.passwordRef!);
  const mongoTarget = source.engine === 'mongodb' ? validateMongoTarget(secret, source, config) : undefined;
  const build = (endpoint?: TunnelEndpoint): ReadAdapter => {
    if (source.engine === 'mysql') return new MysqlReadAdapter(source, {
      host: source.host, port: source.port, user: source.username, password: secret, database: source.database,
      ...(endpoint ? { stream: () => createConnection(endpoint) } : {}),
      connectTimeout: source.budgets.connectTimeoutMs, multipleStatements: false, enableKeepAlive: true,
      // JSON decimals can exceed JS number precision even with supportBigNumbers.
      // Keep their original text, including the distinction between numbers and strings.
      supportBigNumbers: true, bigNumberStrings: true, jsonStrings: true, dateStrings: true, maxPreparedStatements: 16,
      ...(source.tls.mode === 'verify_identity' ? { ssl: { ca, rejectUnauthorized: true, verifyIdentity: true, minVersion: 'TLSv1.2' } } : {}),
    });
    if (source.engine === 'redis') return new RedisReadAdapter(source, secret, ca, endpoint);
    return new MongoReadAdapter(source, secret, ca, endpoint ? { endpoint, target: mongoTarget! } : undefined);
  };
  const ssh = source.ssh;
  if (!ssh) return build;
  const target = source.engine === 'mongodb' ? mongoTarget! : { host: source.host, port: source.port };
  const limits = [source.budgets.connectTimeoutMs, sourceConnectionLimit(source)] as const;
  if (!('hostKeySha256' in ssh)) {
    if (process.platform === 'win32') throw new SafeError('INVALID_CONFIG');
    const { passwordRef } = ssh;
    const password = passwordRef ? await resolveSecret(passwordRef) : undefined;
    if (password && /[\r\n]/.test(password)) throw new SafeError('SECRET_UNAVAILABLE');
    return () => new SshReadAdapter(new LocalSshTunnel(ssh.host, target, ...limits, { password, passwordRef }), build);
  }
  const credentials = await sshCredentials(ssh);
  return () => new SshReadAdapter(new SshTunnel(ssh, target, credentials, ...limits), build);
}

export async function createReadAdapter(source: SourceConfig, config: V2Config): Promise<ReadAdapter> {
  return (await prepareAdapter(source, config))();
}

// One factory per running service. A reconnect replaces transports and drivers
// while preserving the startup snapshot of target, credentials and trust roots.
export function createAdapterFactory(): AdapterFactory {
  const prepared = new WeakMap<SourceConfig, Promise<() => ReadAdapter>>();
  return async (source, config) => {
    let build = prepared.get(source);
    if (!build) {
      build = prepareAdapter(source, config);
      prepared.set(source, build);
    }
    return (await build)();
  };
}
