import { lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { parseV2Config, type V2Config } from './v2.js';
import { createReadAdapter, readCAFile, validateMongoURI } from '../runtime/adapters.js';
import { SafeError } from '../runtime/errors.js';
import { mongoDatabasePattern, mysqlDatabasePattern } from '../runtime/database-scope.js';

type SetupSshAuth = { method: 'password'; password: string } |
  { method: 'private_key'; privateKeyFile: string; passphrase?: string };
export type SetupAnswers = {
  engine: 'mysql' | 'redis' | 'mongodb'; localDevelopment: boolean; host: string; port: number;
  database?: string; username: string; password: string; objects?: Array<{ name: string; fields: string[] }>;
  keyPrefixes?: string[]; readScope?: 'database' | 'allowlist'; caFile?: string; authSource?: string; redisDatabase?: number;
  ssh?: { host: string; password?: string } |
    { host: string; port: number; username: string; hostKeySha256: string; auth: SetupSshAuth };
};
type SetupResult = { configPath: string; clientConfigPath: string };
const messages = {
  INTERACTIVE_REQUIRED: '请在本机交互终端运行 npm run setup；不能通过管道或 MCP 对话输入密码。',
  UNSUPPORTED: '自动配置需要 macOS/Linux 的 Unix 文件权限；Windows 请使用 README 中的 env 配置。',
  CANCELLED: '配置已取消；不会覆盖已有配置。',
  MULTILINE_SECRET: '密码输入包含多行或多余粘贴内容，已取消。请重新运行向导，只粘贴一行密码再按回车。',
  DIRECTORY_UNSAFE: '保存位置必须是当前用户拥有的私有真实目录（0700 或更严），不能是符号链接或共享可写路径。',
  WRITE_FAILED: '配置保存或检查失败；本次新 profile 已尽力清理，已有配置不会被覆盖。请检查目录权限及 CA 文件后重试。',
} as const;
export class SetupError extends Error {
  constructor(public readonly code: keyof typeof messages) { super(messages[code]); this.name = 'SetupError'; }
}
export interface SetupPrompt {
  ask(label: string, options?: { secret?: boolean; defaultValue?: string }): Promise<string>;
  write(message: string): void;
  close(): void;
  readonly signal?: AbortSignal;
}
export function defaultSetupDirectory(): string { return path.join(homedir(), '.config', 'db-mcp'); }
const loopback = (host: string) => ['localhost', '127.0.0.1', '::1'].includes(host);
const validHost = (value: string) => value.length <= 253 && (isIP(value) !== 0 ||
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value));
const reserved = (value: string) => ['__proto__', 'constructor', 'prototype'].includes(value);
const identifier = (value: string) => /^[A-Za-z0-9_$]{1,128}$/.test(value) && !reserved(value);
const mongoField = (value: string) => value.length <= 128 && /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(value) && !value.split('.').some(reserved);
const collection = (value: string) => /^[A-Za-z0-9_.-]{1,128}$/.test(value) && !reserved(value);
const prefix = (value: string) => value.length > 0 && value.length <= 128 && !/[\x00-\x1f*?\[\]\\]/.test(value);
const passwordValid = (value: string) => value.length > 0 && Buffer.byteLength(value) <= 65536 && !/[\0\r\n]/.test(value);

// The wizard only translates answers into the existing v2 contract; it cannot grant writes.
export function createSetupConfig(answers: SetupAnswers, secretPath: string): {
  config: V2Config; input: unknown; secret: string; sshSecrets: Array<{ filename: string; value: string }>;
} {
  try {
    if (!validHost(answers.host) || !passwordValid(answers.password) || !path.isAbsolute(secretPath) ||
        (answers.localDevelopment && (!loopback(answers.host) || answers.caFile)) ||
        (answers.objects !== undefined && !Array.isArray(answers.objects)) ||
        (answers.keyPrefixes !== undefined && !Array.isArray(answers.keyPrefixes))) throw new Error();
    // Existing callers that supply any range keep their restrictions. Only an
    // answer set without ranges defaults to database-wide reads.
    const readScope = answers.readScope ?? (answers.objects !== undefined || answers.keyPrefixes !== undefined ? 'allowlist' : 'database');
    if (!['database', 'allowlist'].includes(readScope) ||
        (readScope === 'database' && (answers.objects?.length || answers.keyPrefixes?.length))) throw new Error();
    const tls = answers.localDevelopment ? { mode: 'disabled' } :
      { mode: 'verify_identity', ...(answers.caFile ? { caFile: answers.caFile } : {}) };
    const sshSecrets: Array<{ filename: string; value: string }> = [];
    const sshSecret = (name: string, value: string) => {
      if (!passwordValid(value)) throw new Error();
      const filename = path.join(path.dirname(secretPath), name);
      sshSecrets.push({ filename, value }); return 'file:' + filename;
    };
    let ssh;
    if (answers.ssh) {
      if (answers.localDevelopment) throw new Error();
      if ('hostKeySha256' in answers.ssh) {
        const { auth, ...server } = answers.ssh;
        ssh = { ...server, auth: auth.method === 'password' ?
          { method: auth.method, passwordRef: sshSecret('ssh-password', auth.password) } :
          { method: auth.method, privateKeyRef: 'file:' + auth.privateKeyFile,
            ...(auth.passphrase ? { passphraseRef: sshSecret('ssh-passphrase', auth.passphrase) } : {}) } };
      } else {
        const { host, password } = answers.ssh;
        ssh = { host, ...(password === undefined ? {} : { passwordRef: sshSecret('ssh-password', password) }) };
      }
    }
    const common = { id: answers.engine, engine: answers.engine, tls, ...(ssh ? { ssh } : {}) };
    let source: unknown;
    let secret = answers.password;
    if (answers.engine === 'redis') {
      const database = answers.redisDatabase ?? 0;
      source = { ...common, host: answers.host, ...(answers.port === 6379 ? {} : { port: answers.port }),
        ...(answers.username === 'default' ? {} : { username: answers.username }),
        passwordRef: 'file:' + secretPath, ...(database === 0 ? {} : { database }),
        access: readScope === 'allowlist' ? { readScope, keyPrefixes: answers.keyPrefixes ?? [] } : {} };
    } else {
      if (readScope === 'allowlist' && (!answers.objects?.length || answers.objects.some(object => !object.fields.length) ||
          new Set(answers.objects.map(object => object.name)).size !== answers.objects.length)) throw new Error();
      const fields = Object.fromEntries((answers.objects ?? []).map(object => [object.name, object.fields]));
      const objects = (answers.objects ?? []).map(object => object.name);
      if (answers.engine === 'mysql') {
        source = { ...common, host: answers.host, ...(answers.port === 3306 ? {} : { port: answers.port }),
          database: answers.database, username: answers.username, passwordRef: 'file:' + secretPath,
          access: readScope === 'allowlist' ? { readScope, tables: objects, columns: fields } : {} };
      } else if (answers.engine === 'mongodb') {
        if (!answers.username || answers.username.length > 128 || !Number.isInteger(answers.port) || answers.port < 1 || answers.port > 65535) throw new Error();
        const host = isIP(answers.host) === 6 ? '[' + answers.host + ']' : answers.host;
        secret = ['mongodb://', encodeURIComponent(answers.username), ':', encodeURIComponent(answers.password), '@', host, ':',
          String(answers.port), '/', encodeURIComponent(answers.database ?? ''), '?authSource=',
          encodeURIComponent(answers.authSource ?? answers.database ?? ''), '&directConnection=true'].join('');
        source = { ...common, database: answers.database, connectionStringRef: 'file:' + secretPath,
          access: readScope === 'allowlist' ? { readScope, collections: objects, fields } : {} };
      } else throw new Error();
    }
    if (Buffer.byteLength(secret) > 65536) throw new Error();
    const input = { version: 2,
      instance: { name: 'db-mcp-read', transport: 'stdio', environment: answers.localDevelopment ? 'development' : 'production' }, sources: [source] };
    const config = parseV2Config(input);
    const parsedSource = config.sources[0];
    if (parsedSource.engine === 'mongodb') validateMongoURI(secret, parsedSource, config);
    return { config, input, secret, sshSecrets };
  } catch { throw new SafeError('INVALID_CONFIG'); }
}

function cancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new SetupError('CANCELLED'); }
async function privateDirectory(directory: string): Promise<void> {
  if (!process.getuid) throw new SetupError('UNSUPPORTED');
  if (!path.isAbsolute(directory)) throw new SetupError('DIRECTORY_UNSAFE');
  const uid = process.getuid();
  // Check the closest existing ancestor before recursive mkdir. Root-owned sticky temp
  // directories are allowed for isolated tests; an ordinary shared-writable path is not.
  let existing = directory;
  while (true) {
    try { await lstat(existing); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(existing) === existing) throw new SetupError('DIRECTORY_UNSAFE');
      existing = path.dirname(existing);
    }
  }
  let ancestor = await realpath(existing);
  while (true) {
    const info = await lstat(ancestor);
    if (!info.isDirectory() || (info.uid !== uid && info.uid !== 0) ||
        ((info.mode & 0o022) !== 0 && !(info.uid === 0 && (info.mode & 0o1000) !== 0))) throw new SetupError('DIRECTORY_UNSAFE');
    if (path.dirname(ancestor) === ancestor) break;
    ancestor = path.dirname(ancestor);
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0) throw new SetupError('DIRECTORY_UNSAFE');
}
async function writePrivate(filename: string, value: string): Promise<void> {
  const handle = await open(filename, 'wx', 0o600);
  try { await handle.writeFile(value, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
}

export async function saveSetup(answers: SetupAnswers, directory: string, entrypoint: string,
  executable = process.execPath, signal?: AbortSignal): Promise<SetupResult> {
  let profile: string | undefined;
  try {
    if (!path.isAbsolute(entrypoint) || !path.isAbsolute(executable)) throw new SetupError('WRITE_FAILED');
    // Invalid answers must not create any files or persist an unvalidated secret.
    createSetupConfig(answers, path.join(directory, 'secret'));
    cancelled(signal); await privateDirectory(directory); cancelled(signal);
    profile = await mkdtemp(path.join(directory, 'profile-'));
    const { config, input, secret, sshSecrets } = createSetupConfig(answers, path.join(profile, 'secret'));
    const configPath = path.join(profile, 'config.json'), clientConfigPath = path.join(profile, 'client.json');
    const encoded = JSON.stringify(input, null, 2) + '\n';
    if (Buffer.byteLength(encoded) > 1024 * 1024) throw new SetupError('WRITE_FAILED');
    cancelled(signal); await writePrivate(path.join(profile, 'secret'), secret); cancelled(signal);
    for (const item of sshSecrets) { await writePrivate(item.filename, item.value); cancelled(signal); }
    await writePrivate(configPath, encoded); cancelled(signal);
    // Validate references and CA readability with the same adapter factory as --check.
    // No connect() is called: neither SSH nor databases are contacted.
    const adapter = await createReadAdapter(config.sources[0], config);
    await adapter.close(); cancelled(signal);
    await writePrivate(clientConfigPath, JSON.stringify({ mcpServers: { 'db-mcp': {
      command: executable, args: [entrypoint, '--config', configPath] } } }, null, 2) + '\n');
    cancelled(signal);
    return { configPath, clientConfigPath };
  } catch (error) {
    if (profile) await rm(profile, { recursive: true, force: true }).catch(() => {});
    if (error instanceof SetupError || error instanceof SafeError) throw error;
    throw new SetupError('WRITE_FAILED');
  }
}

export function createTerminalPrompt(input = process.stdin, output = process.stderr): SetupPrompt {
  if (!process.getuid) throw new SetupError('UNSUPPORTED');
  if (!input.isTTY || !output.isTTY) throw new SetupError('INTERACTIVE_REQUIRED');
  const wasRaw = input.isRaw;
  const controller = new AbortController();
  let hidden = false, closed = false;
  let secretLineComplete = false, allowFollowingLF = false;
  let completion: NodeJS.Immediate | undefined;
  let rejectPending: ((error: SetupError) => void) | undefined;
  const mutedOutput = Object.assign(new Writable({
    write(chunk, encoding, callback) {
      if (hidden) callback(); else output.write(chunk, encoding as BufferEncoding, callback);
    },
  }), { isTTY: true, columns: output.columns ?? 80 });
  // Inspect the terminal's paste protocol before readline can submit a pasted newline.
  // A paste may span any number of data events; elapsed time is not its boundary.
  const decoder = new StringDecoder('utf8');
  const pasteStart = '\x1b[200~', pasteEnd = '\x1b[201~';
  let controlPrefix = '', paste: string | undefined, pasteBytes = 0, invalidPaste = false;
  const close = (reason = new SetupError('CANCELLED')) => {
    if (closed) return;
    closed = true; hidden = true; controller.abort();
    if (completion) clearImmediate(completion);
    const reject = rejectPending; rejectPending = undefined;
    secretEditor?.dispose(); secretEditor = undefined;
    publicEditor.dispose();
    if (!input.destroyed) input.setRawMode(wasRaw ?? false);
    process.removeListener('SIGINT', endInput); process.removeListener('SIGTERM', endInput);
    input.removeListener('data', receive);
    if (input.listenerCount('data') === 0) input.pause();
    input.removeListener('end', endInput); input.removeListener('error', endInput);
    paste = undefined; controlPrefix = '';
    output.write('\x1b[?2004l');
    reject?.(reason);
    mutedOutput.destroy();
  };
  const endInput = () => close();
  const createEditor = () => {
    const stream = new PassThrough();
    const readline = createInterface({ input: stream, output: mutedOutput, terminal: true, historySize: 0 });
    readline.on('close', endInput); readline.on('SIGINT', endInput);
    return { stream, readline, dispose() {
      readline.off('close', endInput);
      readline.close(); stream.destroy();
    } };
  };
  const publicEditor = createEditor();
  // Readline tracks deleted text separately from history. Every secret gets
  // its own editor so neither public prompts nor later secrets inherit it.
  let secretEditor: ReturnType<typeof createEditor> | undefined;
  input.setRawMode(true);
  output.write('\x1b[?2004h');
  const inspectSecretBatch = (chunk: Buffer | string) => {
    if (!hidden || closed) return;
    const text = chunk.toString();
    if (secretLineComplete) {
      // A CRLF terminator may be split across transport chunks. Any actual tail
      // belongs to the secret paste, not to a subsequent public scope question.
      if (allowFollowingLF && text === '\n') { allowFollowingLF = false; return; }
      close(new SetupError('MULTILINE_SECRET')); return;
    }
    const newline = text.search(/[\r\n]/);
    if (newline < 0) return;
    const terminator = text.slice(newline).startsWith('\r\n') ? 2 : 1;
    allowFollowingLF = terminator === 1 && text[newline] === '\r';
    if (text.length > newline + terminator) close(new SetupError('MULTILINE_SECRET'));
  };
  const forward = (text: string) => {
    if (closed) return;
    if (paste !== undefined) {
      if (text.includes('\x03')) { close(); return; }
      if (invalidPaste) return;
      if (/[\r\n\0]/.test(text) || pasteBytes + Buffer.byteLength(text) > 65536) {
        // Drain through the closing marker before restoring terminal echo; otherwise
        // delayed paste tails could be echoed by the terminal after the wizard exits.
        invalidPaste = true; paste = ''; return;
      }
      paste += text; pasteBytes += Buffer.byteLength(text);
    } else {
      inspectSecretBatch(text);
      if (!closed) (secretEditor ?? publicEditor).stream.write(text);
    }
  };
  const receive = (chunk: Buffer | string) => {
    if (closed) return;
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    for (const character of text) {
      if (closed) break;
      controlPrefix += character;
      while (controlPrefix && !closed) {
        if (controlPrefix === pasteStart) {
          if (paste !== undefined) { invalidPaste = true; controlPrefix = ''; break; }
          paste = ''; pasteBytes = 0; invalidPaste = false; controlPrefix = ''; break;
        }
        if (controlPrefix === pasteEnd) {
          if (paste === undefined) { close(new SetupError('MULTILINE_SECRET')); break; }
          const value = paste; paste = undefined; controlPrefix = '';
          if (invalidPaste) { close(new SetupError('MULTILINE_SECRET')); break; }
          // Paste is one literal line. Enter must be a separate user action.
          (secretEditor ?? publicEditor).readline.write(value); break;
        }
        if (pasteStart.startsWith(controlPrefix) || pasteEnd.startsWith(controlPrefix)) break;
        const first = Array.from(controlPrefix)[0];
        controlPrefix = controlPrefix.slice(first.length); forward(first);
      }
    }
  };
  input.on('data', receive); input.once('end', endInput); input.once('error', endInput);
  process.once('SIGINT', endInput); process.once('SIGTERM', endInput);
  return {
    signal: controller.signal,
    write: message => { if (!closed) output.write(message); }, close,
    ask: (label, options) => new Promise<string>((resolve, reject) => {
      if (closed) { reject(new SetupError('CANCELLED')); return; }
      output.write(label + (options?.defaultValue !== undefined ? ' [' + options.defaultValue + ']' : '') + ': ');
      hidden = options?.secret === true;
      if (hidden) secretEditor = createEditor();
      secretLineComplete = false; allowFollowingLF = false;
      rejectPending = reject;
      (secretEditor ?? publicEditor).readline.question('', answer => {
        if (closed) return;
        if (hidden) {
          secretLineComplete = true;
          // Keep the whole current input turn muted, including buffered paste tails.
          completion = setImmediate(() => {
            completion = undefined;
            if (closed) return;
            secretEditor?.dispose(); secretEditor = undefined;
            hidden = false; secretLineComplete = false; rejectPending = undefined;
            output.write('\n'); resolve(answer);
          });
        } else { rejectPending = undefined; resolve(answer); }
      });
    }),
  };
}

export async function runSetup(prompt: SetupPrompt, directory: string, entrypoint: string,
  executable = process.execPath): Promise<SetupResult> {
  try {
    prompt.write('\n欢迎使用 db-mcp 只读配置向导。密码只在本机隐藏输入，不连接数据库，也不开放写入。\n不清楚数据库地址、账号或证书时，请先向数据库管理员确认。Ctrl-C 可取消。\n\n');
    const ask = async (label: string, validate: (value: string) => boolean | Promise<boolean>,
      hint: string, options?: { secret?: boolean; defaultValue?: string }) => {
      while (true) {
        cancelled(prompt.signal);
        const raw = await prompt.ask(label, options);
        const value = options?.secret ? raw : raw.trim() || options?.defaultValue || '';
        if (await validate(value)) return value;
        prompt.write(hint + '\n');
      }
    };
    const engineChoice = await ask('数据库类型：1 MySQL / 2 Redis / 3 MongoDB', v => ['1', '2', '3'].includes(v), '请输入 1、2 或 3。', { defaultValue: '1' });
    const engine = ({ '1': 'mysql', '2': 'redis', '3': 'mongodb' } as const)[engineChoice as '1' | '2' | '3'];
    const localDevelopment = await ask('用途：1 真实业务/线上（验证 TLS）/ 2 本机开发测试（仅回环，禁用 TLS）', v => ['1', '2'].includes(v), '请输入 1 或 2；不要将生产库标为开发库。', { defaultValue: '1' }) === '2';
    const useSsh = !localDevelopment && await ask('连接方式：1 直接连接 / 2 SSH 通道（跳板机）', value => ['1', '2'].includes(value),
      '请输入 1 或 2。SSH 服务器必须能访问数据库。', { defaultValue: '1' }) === '2';
    prompt.write(useSsh ? '数据库地址由 SSH 服务器解析并访问；请填写它能访问且与数据库 TLS 证书匹配的原地址。\n' :
      '数据库地址由运行 db-mcp 的本机解析并访问。\n');
    const host = await ask('数据库地址（不含协议或端口）', value => validHost(value) &&
      (!localDevelopment || loopback(value)) && (localDevelopment || engine !== 'mysql' || !isIP(value)),
      localDevelopment ? '本机开发仅接受 localhost、127.0.0.1 或 ::1。' : engine === 'mysql' ? 'MySQL TLS 请填写证书匹配的 DNS 名称，不接受 IP。' : '请输入有效的主机名或 IP；TLS 证书须匹配它。', { defaultValue: 'localhost' });
    const port = Number(await ask('端口', value => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535,
      '端口须为 1 到 65535 的整数。', { defaultValue: engine === 'mysql' ? '3306' : engine === 'redis' ? '6379' : '27017' }));
    let database: string | undefined, redisDatabase: number | undefined;
    if (engine === 'redis') redisDatabase = Number(await ask('Redis 库编号', value => /^\d+$/.test(value) && Number(value) <= 15, '请输入 0 到 15。', { defaultValue: '0' }));
    else database = await ask('数据库名', value => (engine === 'mysql' ? mysqlDatabasePattern : mongoDatabasePattern).test(value), '请填写数据库名，不是连接 URI。');
    const username = await ask(engine === 'redis' ? 'Redis 用户名（已有默认账号可直接回车）' : '专用数据库账号（请向管理员索取，不使用 root）',
      value => value.length > 0 && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value) && value.toLowerCase() !== 'root',
      '请填写有效账号；不支持 root。Redis 只读连接可使用 default。', engine === 'redis' ? { defaultValue: 'default' } : undefined);
    const password = await ask('密码（隐藏输入，保留首尾空格）', passwordValid, '密码不能为空、含 NUL/换行或超过 64 KiB。', { secret: true });
    prompt.write('读取范围默认覆盖当前已配置数据库内账号可见的全部内容，可能包含敏感数据；不是整台服务器，也不会开放写入。需要缩小范围时请选择 2 指定名单。Redis 仍不会自动扫描 key。\n');
    const readScope = (await ask('读取范围：1 已配置数据库内全部可读 / 2 指定名单', value => ['1', '2'].includes(value),
      '请输入 1 或 2；全部可读可能让模型读取该库中的敏感数据。', { defaultValue: '1' })) === '1' ? 'database' : 'allowlist';
    const list = (value: string) => [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))];
    let objects: SetupAnswers['objects'], keyPrefixes: string[] | undefined;
    if (readScope === 'allowlist' && engine === 'redis') {
      keyPrefixes = list(await ask('允许读取的 key 前缀（例 reports:，多个用逗号分隔，不含 *）', value => {
        const values = list(value); return values.length > 0 && values.length <= 16 && values.every(prefix);
      }, '请填写 1 到 16 个字面量前缀，不能用通配符；不会开放扫描。'));
    } else if (readScope === 'allowlist') {
      if (engine === 'mongodb') prompt.write('提示：允许一个父字段会包含它的全部子字段；只需某个子字段时请填写 profile.name 这样的完整路径。\n');
      const names = list(await ask(engine === 'mysql' ? '允许读取的表/视图（例 reports，多个用逗号分隔）' : '允许读取的集合（例 reports，多个用逗号分隔）', value => {
        const values = list(value); return values.length > 0 && values.length <= 128 && values.every(engine === 'mysql' ? identifier : collection);
      }, '请填写明确的表/集合名称，不能用 * 代替整个数据库。'));
      objects = [];
      for (const name of names) objects.push({ name, fields: list(await ask(name + ' 允许读取的字段（例 ' + (engine === 'mysql' ? 'id,name' : '_id,name') + '，逗号分隔）', value => {
        const values = list(value); return values.length > 0 && values.length <= 128 && values.every(engine === 'mysql' ? identifier : mongoField);
      }, '字段必须明确列出，不能留空或用 *；MongoDB 父字段会包含其全部子字段。')) });
    }
    let authSource: string | undefined, caFile: string | undefined;
    if (engine === 'mongodb') authSource = await ask('MongoDB 认证库（账号创建的位置）', value => /^[A-Za-z0-9_-]{1,64}$/.test(value), '请向管理员确认认证库名称。', { defaultValue: database });
    if (!localDevelopment) caFile = await ask('CA 证书文件绝对路径（系统信任证书可直接回车）', async value => {
      if (!value) return true;
      if (!path.isAbsolute(value)) return false;
      try { await readCAFile(value); return true; }
      catch { return false; }
    }, '请提供可读取的普通 CA 文件绝对路径，大小不超过 1 MiB。') || undefined;
    let ssh: SetupAnswers['ssh'];
    if (useSsh) {
      const sshHost = await ask('SSH IP、域名或 ~/.ssh/config 别名', validHost, '请填写有效的 SSH IP、域名或别名。');
      prompt.write('SSH 读取本机的用户、端口、密钥和已知主机配置。数据库地址由 SSH 服务器解析并访问，TLS 校验原数据库主机名。\n');
      const method = await ask('SSH 认证：1 本机密钥 / 2 密码', value => ['1', '2'].includes(value), '请输入 1 或 2。', { defaultValue: '1' });
      ssh = { host: sshHost, ...(method === '2' ? {
        password: await ask('SSH 密码（隐藏输入）', passwordValid, '密码不能为空、含换行或超过 64 KiB。', { secret: true }),
      } : {}) };
    }
    if ((await ask('保存只读配置并生成客户端启动项？y/n', value => ['y', 'n'].includes(value.toLowerCase()), '请输入 y 或 n。', { defaultValue: 'y' })).toLowerCase() !== 'y') throw new SetupError('CANCELLED');
    const result = await saveSetup({ engine, localDevelopment, host, port, database, redisDatabase, username, password,
      readScope, objects, keyPrefixes, authSource, caFile, ssh }, directory, entrypoint, executable, prompt.signal);
    prompt.write('\n只读配置已生成：' + result.configPath + '\n客户端启动项：' + result.clientConfigPath +
      '\n打开 client.json，只复制 mcpServers 中的 db-mcp 条目到现有客户端，勿覆盖整个配置；然后重载客户端。\n' +
      '本次仅做配置/秘密引用检查，未连接 SSH 或数据库，未验证真实 TLS/账号权限。首次接入后调用 list_sources 和一次受限查询。\n');
    return result;
  } catch (error) {
    if (error instanceof SetupError || error instanceof SafeError) throw error;
    throw new SetupError('CANCELLED');
  } finally { prompt.close(); }
}
