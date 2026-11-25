import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import ssh2, { type ConnectConfig, type ClientChannel } from 'ssh2';
import type { PinnedSshConfig } from '../config/v2.js';
import { resolveSecret } from '../config/secrets.js';
import { SafeError, type ErrorCode } from './errors.js';
import type { ReadAdapter } from './sources.js';
import type { ReadPlan } from './policy.js';
const { Client, utils } = ssh2;

export type TunnelEndpoint = { host: '127.0.0.1'; port: number };
export type TunnelTarget = { host: string; port: number };
export interface Tunnel {
  connect(): Promise<TunnelEndpoint>;
  close(): Promise<void>;
  onDisconnect?: (code: ErrorCode) => void;
}

// Resolve and validate credentials during --check, without opening a socket.
export async function sshCredentials(config: PinnedSshConfig): Promise<Pick<ConnectConfig, 'password' | 'privateKey' | 'passphrase'>> {
  if (config.auth.method === 'password') return { password: await resolveSecret(config.auth.passwordRef) };
  const privateKey = await resolveSecret(config.auth.privateKeyRef);
  const passphrase = config.auth.passphraseRef ? await resolveSecret(config.auth.passphraseRef) : undefined;
  const parsed = utils.parseKey(privateKey, passphrase);
  if (parsed instanceof Error || (Array.isArray(parsed) ? parsed : [parsed]).some(key => !key.isPrivateKey())) {
    throw new SafeError('INVALID_CONFIG');
  }
  return { privateKey, ...(passphrase !== undefined ? { passphrase } : {}) };
}

/** One SSH session and loopback-only, bounded listener for one immutable database target. */
export class SshTunnel {
  private readonly client = new Client();
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  private readonly channels = new Set<ClientChannel>();
  private readonly waiting = new Map<Socket, { deadline: number; remove(): void }>();
  private closed = false;
  private started = false;
  private ready = false;
  private rejectConnect?: (error: SafeError) => void;
  private deadline?: NodeJS.Timeout;
  private hostKeyRejected = false;
  private closing?: Promise<void>;
  private clientClosed?: Promise<void>;
  onDisconnect?: (code: ErrorCode) => void;

  constructor(private readonly config: PinnedSshConfig, private readonly target: TunnelTarget,
    private readonly credentials: Awaited<ReturnType<typeof sshCredentials>>,
    private readonly timeoutMs: number, private readonly maxConnections: number) {}

  async connect(): Promise<TunnelEndpoint> {
    if (this.started || this.closed) throw new SafeError('SSH_UNAVAILABLE');
    this.started = true;
    return new Promise<TunnelEndpoint>((resolve, reject) => {
      this.rejectConnect = reject;
      const fail = () => this.fail();
      let markClientClosed = () => {};
      this.clientClosed = new Promise<void>(resolve => { markClientClosed = resolve; });
      this.client.once('close', markClientClosed);
      this.client.on('error', error => this.fail(error.level === 'client-authentication' ? 'SSH_AUTH_FAILED' : 'SSH_UNAVAILABLE'))
        .on('close', fail).on('end', fail);
      this.client.once('ready', () => {
        if (this.closed) return;
        this.server = createServer(socket => this.accept(socket));
        this.server.on('error', fail);
        this.server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
          if (this.closed) { this.server?.close(); return; }
          const address = this.server!.address();
          if (!address || typeof address === 'string') { fail(); return; }
          this.ready = true; clearTimeout(this.deadline); this.rejectConnect = undefined;
          resolve({ host: '127.0.0.1', port: address.port });
        });
      });
      this.deadline = setTimeout(fail, this.timeoutMs);
      try {
        const expected = Buffer.from(this.config.hostKeySha256.slice(7), 'base64');
        this.client.connect({ host: this.config.host, port: this.config.port, username: this.config.username,
          ...this.credentials, readyTimeout: this.timeoutMs, keepaliveInterval: 5000, keepaliveCountMax: 3,
          tryKeyboard: false,
          hostVerifier: (key: Buffer) => {
            const valid = timingSafeEqual(createHash('sha256').update(key).digest(), expected);
            this.hostKeyRejected = !valid;
            return valid;
          },
        });
      } catch { markClientClosed(); fail(); }
    });
  }

  private fail(reason: ErrorCode = 'SSH_UNAVAILABLE'): void {
    if (this.closed) return;
    const wasReady = this.ready;
    const code = this.hostKeyRejected ? 'SSH_HOST_KEY_MISMATCH' : reason;
    this.rejectConnect?.(new SafeError(code));
    void this.close();
    if (wasReady) this.onDisconnect?.(code);
  }

  private accept(socket: Socket): void {
    socket.on('error', () => {});
    if (this.closed || !this.ready) { socket.destroy(); return; }
    socket.pause();
    const deadline = Date.now() + this.timeoutMs;
    if (this.sockets.size < this.maxConnections) {
      this.forward(socket, deadline);
      return;
    }
    // The driver's socket can be closed before its SSH channel acknowledges
    // closure. A bounded local wait absorbs this gap without opening extra channels.
    if (this.waiting.size >= this.maxConnections) { socket.destroy(); return; }
    const timer = setTimeout(() => socket.destroy(), this.timeoutMs);
    const remove = () => {
      clearTimeout(timer); socket.off('close', remove); this.waiting.delete(socket);
    };
    this.waiting.set(socket, { deadline, remove });
    socket.once('close', remove);
  }

  private release(socket: Socket): void {
    if (!this.sockets.delete(socket) || this.closed) return;
    for (const [next, waiting] of this.waiting) {
      waiting.remove();
      if (next.destroyed || Date.now() >= waiting.deadline) { next.destroy(); continue; }
      this.forward(next, waiting.deadline);
      break;
    }
  }

  private forward(socket: Socket, connectDeadline: number): void {
    this.sockets.add(socket); socket.setNoDelay(true);
    let channel: ClientChannel | undefined;
    let closeDeadline: NodeJS.Timeout | undefined;
    let opening = true;
    // ssh2 cannot cancel an individual pending channel-open request. Losing its
    // local socket must close the session before the connection slot can be reused.
    const deadline = setTimeout(() => this.fail(), Math.max(1, connectDeadline - Date.now()));
    socket.once('close', () => {
      clearTimeout(deadline);
      if (opening) this.fail();
      if (!channel) { this.release(socket); return; }
      // Leave the slot reserved until SSH confirms channel closure. Otherwise a
      // silent peer could collect abandoned channels across many local sockets.
      if (!this.closed) closeDeadline = setTimeout(() => this.fail(), this.timeoutMs);
      socket.unpipe(channel);
      this.discardChannel(channel);
    });
    try {
      this.client.forwardOut('127.0.0.1', socket.remotePort ?? 0, this.target.host, this.target.port, (error, stream) => {
        opening = false;
        clearTimeout(deadline);
        if (error || this.closed) { if (stream) this.discardChannel(stream); socket.destroy(); return; }
        channel = stream; this.channels.add(stream);
        stream.on('error', () => socket.destroy());
        stream.once('close', () => {
          clearTimeout(closeDeadline);
          this.channels.delete(stream); channel = undefined;
          if (socket.destroyed) this.release(socket);
          else socket.destroy();
        });
        if (socket.destroyed) return; // Its pending close event will dispose of the newly opened channel.
        socket.pipe(stream).pipe(socket); socket.resume();
      });
    } catch { this.fail(); }
  }

  private discardChannel(channel: ClientChannel): void {
    channel.unpipe();
    // ssh2 emits channel close only after the readable side ends. Its destroy()
    // requests protocol closure but leaves a paused reader and its buffer intact.
    channel.resume();
    channel.destroy();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.ready = false; clearTimeout(this.deadline);
    this.rejectConnect?.(new SafeError('SSH_UNAVAILABLE')); this.rejectConnect = undefined;
    for (const socket of this.waiting.keys()) socket.destroy();
    for (const socket of this.sockets) socket.destroy();
    for (const channel of this.channels) this.discardChannel(channel);
    const listenerClosed = this.server ? new Promise<void>(resolve => this.server!.close(() => resolve())) : undefined;
    this.client.destroy();
    this.closing = Promise.all([listenerClosed, this.clientClosed]).then(() => {
      this.waiting.clear(); this.sockets.clear(); this.channels.clear();
    });
    return this.closing;
  }
}

export class SshReadAdapter implements ReadAdapter {
  private adapter?: ReadAdapter;
  private closed = false;
  private unavailable?: (code: ErrorCode) => void;
  private closing?: Promise<void>;
  constructor(private readonly tunnel: Tunnel, private readonly build: (endpoint: TunnelEndpoint) => ReadAdapter) {
    tunnel.onDisconnect = code => this.disconnect(code);
  }
  private disconnect(code: ErrorCode): void {
    if (this.closed) return;
    void this.close().catch(() => {});
    this.unavailable?.(code);
  }
  onUnavailable(callback: (code: ErrorCode) => void): void { this.unavailable = callback; }
  get writer() { return this.adapter?.writer; }
  async connect(): Promise<void> {
    if (this.closed) throw new SafeError('SSH_UNAVAILABLE');
    try {
      const endpoint = await this.tunnel.connect();
      if (this.closed) throw new SafeError('SSH_UNAVAILABLE');
      this.adapter = this.build(endpoint);
      let databaseReady = false;
      let databaseFailure: ErrorCode | undefined;
      this.adapter.onUnavailable?.(code => {
        if (databaseReady) this.disconnect(code);
        else databaseFailure = code;
      });
      await this.adapter.connect();
      if (this.closed) throw new SafeError('SSH_UNAVAILABLE');
      if (databaseFailure) throw new SafeError(databaseFailure);
      databaseReady = true;
    } catch (error) { await this.close(); throw error; }
  }
  async *read(plan: ReadPlan, signal: AbortSignal): AsyncIterable<unknown> {
    if (this.closed || !this.adapter) throw new SafeError('SOURCE_UNAVAILABLE');
    yield* this.adapter.read(plan, signal);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      try { await this.tunnel.close(); }
      finally { await this.adapter?.close(); }
    })();
    return this.closing;
  }
}
