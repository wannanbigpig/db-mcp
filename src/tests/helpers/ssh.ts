import { createConnection, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import ssh2, { type Connection, type ServerChannel, type TcpipRequestInfo } from 'ssh2';
import type { PinnedSshConfig } from '../../config/v2.js';
const { Server, utils } = ssh2;

const hostKey = utils.generateKeyPairSync('ed25519');
export const clientKey = utils.generateKeyPairSync('ed25519', { passphrase: 'fixture-key-passphrase', cipher: 'aes256-cbc', rounds: 1 });
export const localClientKey = utils.generateKeyPairSync('ed25519');
const parsed = utils.parseKey(hostKey.private);
if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Fixture host key failed');
const fingerprint = 'SHA256:' + createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '');
const publicKey = utils.parseKey(clientKey.public);
if (publicKey instanceof Error || Array.isArray(publicKey)) throw new Error('Fixture client key failed');
const verifiedKey = publicKey;
const localPublicKey = utils.parseKey(localClientKey.public);
if (localPublicKey instanceof Error || Array.isArray(localPublicKey)) throw new Error('Fixture local client key failed');
const verifiedKeys = [verifiedKey, localPublicKey];

export async function sshFixture(upstream: { host?: string; port: number }, options: { rejectForward?: boolean; stall?: boolean } = {}) {
  const connections = new Set<Connection>(), sockets = new Set<Socket>(), channels = new Set<ServerChannel>();
  const targets: TcpipRequestInfo[] = [];
  let authAttempts = 0;
  let backendOnline = true;
  const server = new Server({ hostKeys: [hostKey.private] }, connection => {
    connections.add(connection);
    connection.on('error', () => {});
    connection.once('close', () => connections.delete(connection));
    connection.on('authentication', context => {
      authAttempts++;
      if (options.stall) return;
      if (context.username !== 'tunnel') { context.reject(); return; }
      if (context.method === 'password' && context.password === 'fixture-ssh-password') { context.accept(); return; }
      if (context.method === 'publickey' && verifiedKeys.some(key => context.key.data.equals(key.getPublicSSH()) &&
        (!context.signature || key.verify(context.blob!, context.signature, context.hashAlgo) === true))) { context.accept(); return; }
      context.reject();
    });
    connection.on('tcpip', (accept, reject, info) => {
      targets.push(info);
      if (!backendOnline || options.rejectForward) { reject(); return; }
      const socket = createConnection({ host: upstream.host ?? '127.0.0.1', port: upstream.port }); sockets.add(socket);
      socket.on('error', () => { reject(); });
      socket.once('close', () => sockets.delete(socket));
      socket.once('connect', () => {
        const channel = accept(); channels.add(channel);
        channel.on('error', () => socket.destroy());
        channel.once('close', () => { channels.delete(channel); socket.destroy(); });
        socket.once('close', () => channel.destroy());
        channel.pipe(socket).pipe(channel);
      });
    });
  });
  server.on('error', () => {});
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error();
  const config: PinnedSshConfig = { host: '127.0.0.1', port: address.port, username: 'tunnel', hostKeySha256: fingerprint,
    auth: { method: 'password', passwordRef: 'env:DB_MCP_SSH_FIXTURE' } };
  return { config, hostPublicKey: hostKey.public, targets, authAttempts: () => authAttempts,
    setBackendOnline(online: boolean) {
      backendOnline = online;
      if (!online) for (const socket of sockets) socket.destroy();
    },
    disconnect: () => { for (const connection of connections) connection.end(); },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      for (const channel of channels) channel.destroy();
      for (const connection of connections) connection.end();
      await new Promise<void>(resolve => server.close(() => resolve()));
    } };
}
