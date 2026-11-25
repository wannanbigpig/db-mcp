import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer, isIP, type Server, type Socket } from 'node:net';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';
import { SafeError, type ErrorCode } from './errors.js';
import type { Tunnel, TunnelEndpoint, TunnelTarget } from './ssh-tunnel.js';

const run = promisify(execFile);
const ssh = process.platform === 'darwin' ? '/usr/bin/ssh' : 'ssh';
const askpass = [
  '#!/bin/sh',
  "exec \"$DB_MCP_ASKPASS_NODE\" -e '",
  'const socket = require("node:net").createConnection(process.env.DB_MCP_ASKPASS_SOCKET);',
  'socket.setTimeout(2000, () => socket.destroy());',
  'socket.once("connect", () => socket.write(String(process.ppid) + "\\n"));',
  'socket.on("error", () => { process.exitCode = 1; });',
  'socket.pipe(process.stdout);',
  "'",
].join('\n') + '\n';

function sshFailure(stderr: string): ErrorCode {
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) return 'SSH_HOST_KEY_MISMATCH';
  if (/Permission denied|Too many authentication failures/i.test(stderr)) return 'SSH_AUTH_FAILED';
  return 'SSH_UNAVAILABLE';
}

function listen(server: Server, endpoint: string | { host: string; port: number }, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => reject(signal.reason);
    server.once('error', reject);
    signal.addEventListener('abort', onAbort, { once: true });
    server.listen(typeof endpoint === 'string' ? { path: endpoint, signal } : { ...endpoint, signal, exclusive: true }, () => {
      signal.removeEventListener('abort', onAbort);
      server.removeListener('error', reject);
      resolve();
    });
  });
}

export class LocalSshTunnel implements Tunnel {
  private readonly stop = new AbortController();
  private readonly sockets = new Set<Socket>();
  private directory?: string;
  private server?: Server;
  private passwordServer?: Server;
  private master?: ChildProcess;
  private masterClosed?: Promise<void>;
  private starting?: Promise<TunnelEndpoint>;
  private closing?: Promise<void>;
  private ready = false;
  onDisconnect?: (code: ErrorCode) => void;

  constructor(private readonly host: string, private readonly target: TunnelTarget,
    private readonly timeoutMs: number, private readonly maxConnections: number,
    private readonly options: { password?: string; passwordRef?: string; configFile?: string } = {}) {}

  connect(): Promise<TunnelEndpoint> {
    if (this.starting || this.closing) return Promise.reject(new SafeError('SSH_UNAVAILABLE'));
    const deadline = setTimeout(() => this.fail('SSH_UNAVAILABLE'), this.timeoutMs);
    this.starting = this.start().catch(error => {
      throw this.stop.signal.reason ?? (error instanceof SafeError ? error : new SafeError('SSH_UNAVAILABLE'));
    }).finally(() => clearTimeout(deadline));
    return this.starting;
  }

  private fail(code: ErrorCode): void {
    if (this.stop.signal.aborted) return;
    this.stop.abort(new SafeError(code));
    if (this.ready) this.onDisconnect?.(code);
  }

  private async start(): Promise<TunnelEndpoint> {
    const { signal } = this.stop;
    // Use a short private directory to fit the Unix socket address limit on macOS and Linux.
    const directory = this.directory = await mkdtemp('/tmp/dbm-ssh-');
    const control = path.join(directory, 'ctl');
    const forwarded = path.join(directory, 'db');
    const env = { ...process.env, LC_ALL: 'C', SSH_ASKPASS_REQUIRE: 'never' };
    const password = this.options.password;
    if (password !== undefined) await this.prepareAskpass(directory, env, password);
    signal.throwIfAborted();
    const args = this.options.configFile ? ['-F', this.options.configFile] : [];
    const sshOptions = [
      'ControlPersist=no', 'StrictHostKeyChecking=yes', 'UpdateHostKeys=no', 'ExitOnForwardFailure=yes',
      'ClearAllForwardings=yes', 'PermitLocalCommand=no', 'ForkAfterAuthentication=no', 'Tunnel=no',
      'ForwardAgent=no', 'ForwardX11=no', 'ServerAliveInterval=5', 'ServerAliveCountMax=3',
      ...(password === undefined ? ['BatchMode=yes', 'PreferredAuthentications=publickey'] :
        ['BatchMode=no', 'PreferredAuthentications=password', 'KbdInteractiveAuthentication=no', 'NumberOfPasswordPrompts=1']),
    ];
    const master = this.master = spawn(ssh, [
      ...args, '-M', '-S', control, '-N', '-T', ...sshOptions.flatMap(option => ['-o', option]), '--', this.host,
    ], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    master.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
    master.once('error', () => this.fail('SSH_UNAVAILABLE'));
    this.masterClosed = new Promise(resolve => master.once('close', () => {
      this.fail(sshFailure(stderr));
      resolve();
    }));

    // OpenSSH creates the control socket after authenticating. Add only our own
    // forward after OpenSSH has discarded all forwarding rules from the user's config.
    while (!(await lstat(control).catch(() => undefined))?.isSocket()) await wait(20, undefined, { signal });
    signal.throwIfAborted();
    const target = isIP(this.target.host) === 6 ? '[' + this.target.host + ']' : this.target.host;
    await run(ssh, ['-F', '/dev/null', '-S', control, '-O', 'forward', '-L',
      forwarded + ':' + target + ':' + this.target.port, '--', this.host], { signal, maxBuffer: 8192 });
    signal.throwIfAborted();
    this.passwordServer?.close();
    const server = this.server = createServer(socket => this.forward(socket, forwarded));
    server.on('error', () => this.fail('SSH_UNAVAILABLE'));
    await listen(server, { host: '127.0.0.1', port: 0 }, signal);
    signal.throwIfAborted();
    const address = server.address();
    if (!address || typeof address === 'string') throw new SafeError('SSH_UNAVAILABLE');
    this.ready = true;
    return { host: '127.0.0.1', port: address.port };
  }

  private async prepareAskpass(directory: string, env: NodeJS.ProcessEnv, password: string): Promise<void> {
    const socketPath = path.join(directory, 'ask');
    const program = path.join(directory, 'askpass');
    await writeFile(program, askpass, { mode: 0o700, flag: 'wx' });
    let sent = false;
    const server = this.passwordServer = createServer(socket => {
      socket.on('error', () => socket.destroy());
      socket.setTimeout(1000, () => socket.destroy());
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
      let request = '';
      socket.on('data', data => {
        request += data.toString('ascii');
        if (request.length > 32 || this.stop.signal.aborted) { socket.destroy(); return; }
        if (!request.endsWith('\n')) return;
        // Only the main SSH client gets this password. A ProxyJump subprocess
        // can inherit the helper but has a different PID.
        if (sent || request !== String(this.master?.pid) + '\n') { socket.destroy(); return; }
        sent = true;
        socket.end(password + '\n');
      });
    });
    server.on('error', () => this.fail('SSH_UNAVAILABLE'));
    await listen(server, socketPath, this.stop.signal);
    Object.assign(env, { SSH_ASKPASS: program, SSH_ASKPASS_REQUIRE: 'force',
      DB_MCP_ASKPASS_NODE: process.execPath, DB_MCP_ASKPASS_SOCKET: socketPath });
    if (this.options.passwordRef?.startsWith('env:')) delete env[this.options.passwordRef.slice(4)];
  }

  private forward(local: Socket, forwarded: string): void {
    local.on('error', () => local.destroy());
    if (this.stop.signal.aborted || this.sockets.size >= this.maxConnections * 2) { local.destroy(); return; }
    const upstream = createConnection(forwarded);
    upstream.on('error', () => upstream.destroy());
    this.sockets.add(local).add(upstream);
    local.once('close', () => { this.sockets.delete(local); upstream.destroy(); });
    upstream.once('close', () => { this.sockets.delete(upstream); local.destroy(); });
    local.pipe(upstream).pipe(local);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stop.abort(new SafeError('SSH_UNAVAILABLE'));
    this.closing = (async () => {
      await this.starting?.catch(() => {});
      for (const socket of this.sockets) socket.destroy();
      const closeServer = (server?: Server) => server && new Promise<void>(resolve => server.close(() => resolve()));
      this.master?.kill();
      const force = setTimeout(() => this.master?.kill('SIGKILL'), 1000);
      try { await Promise.all([this.masterClosed, closeServer(this.server), closeServer(this.passwordServer)]); }
      finally { clearTimeout(force); }
      if (this.directory) await rm(this.directory, { recursive: true, force: true });
    })();
    return this.closing;
  }
}
