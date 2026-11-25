import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createTerminalPrompt } from '../config/setup.js';

function terminal() {
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false,
    setRawMode(mode: boolean) { this.isRaw = mode; return this; } });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  let transcript = '';
  output.on('data', data => { transcript += data.toString(); });
  return { input, output, transcript: () => transcript,
    prompt: () => createTerminalPrompt(input as unknown as typeof process.stdin, output as unknown as typeof process.stderr) };
}

test('setup terminal rejects piped input before requesting a password', () => {
  const input = new PassThrough(), output = new PassThrough();
  assert.throws(() => createTerminalPrompt(input as unknown as typeof process.stdin, output as unknown as typeof process.stderr), /终端/);
  input.destroy(); output.destroy();
});

test('setup terminal hides password and restores raw mode without leaking into the next prompt', async () => {
  const tty = terminal(); const prompt = tty.prompt();
  try {
    const password = '  terminal-secret-隐藏-@:/%  ';
    const answer = prompt.ask('密码', { secret: true });
    tty.input.write(password + '\r');
    assert.equal(await answer, password);
    assert.ok(!tty.transcript().includes(password));
    assert.ok(!tty.transcript().includes('terminal-secret'));
    const next = prompt.ask('表名'); tty.input.write('reports\r');
    assert.equal(await next, 'reports');
    assert.ok(tty.transcript().includes('表名'));
    assert.ok(!tty.transcript().includes('terminal-secret'));
  } finally { prompt.close(); tty.input.destroy(); tty.output.destroy(); }
  assert.equal(tty.input.isRaw, false);
});

test('editing a hidden answer does not change the public editor state', async t => {
  const term = process.env.TERM;
  process.env.TERM = 'xterm';
  t.after(() => { if (term === undefined) delete process.env.TERM; else process.env.TERM = term; });
  const tty = terminal(); const prompt = tty.prompt();
  try {
    const first = prompt.ask('第一个公开问题');
    tty.input.write('public-field\x15replacement\r');
    assert.equal(await first, 'replacement');

    const secret = prompt.ask('密码', { secret: true });
    tty.input.write('discarded-fixture\x15accepted-fixture\r');
    assert.equal(await secret, 'accepted-fixture');
    assert.equal(tty.input.isRaw, true);

    const second = prompt.ask('下一个公开问题');
    tty.input.write('\x19\r');
    assert.equal(await second, 'public-field');
    assert.doesNotMatch(tty.transcript(), /discarded-fixture|accepted-fixture/);
  } finally { prompt.close(); tty.input.destroy(); tty.output.destroy(); }
});

for (const ending of ['eof', 'ctrl-c'] as const) test('setup terminal ' + ending + ' aborts hidden input and restores raw mode', async () => {
  const tty = terminal(); const prompt = tty.prompt();
  try {
    const pending = prompt.ask('密码', { secret: true });
    const denied = assert.rejects(pending, /取消/);
    tty.input.write('partial-secret-do-not-echo');
    if (ending === 'eof') tty.input.end(); else tty.input.write('\x03');
    await denied;
    assert.equal(tty.input.isRaw, false);
    assert.ok(!tty.transcript().includes('partial-secret'));
  } finally { prompt.close(); tty.input.destroy(); tty.output.destroy(); }
});

for (const split of [false, true]) test('setup terminal rejects multi-line password paste without echoing any tail ' + (split ? 'across buffered chunks' : 'in one chunk'), async () => {
  const tty = terminal(); const prompt = tty.prompt();
  try {
    const pending = prompt.ask('密码', { secret: true });
    const denied = assert.rejects(pending, /多行/);
    void denied.catch(() => {});
    if (split) { tty.input.write('FAKE_PASSWORD_HEAD\r'); tty.input.write('FAKE_PASSWORD_TAIL\r'); }
    else tty.input.write('FAKE_PASSWORD_HEAD\rFAKE_PASSWORD_TAIL\r');
    await denied;
    await assert.rejects(prompt.ask('读取范围'), /取消/);
    const text = tty.transcript().replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    assert.ok(!text.includes('FAKE_PASSWORD_HEAD')); assert.ok(!text.includes('PASSWORD_TAIL'));
    assert.equal(tty.input.isRaw, false); assert.equal(prompt.signal?.aborted, true);
  } finally { prompt.close(); tty.input.destroy(); tty.output.destroy(); }
});

for (const splitMarker of [false, true]) test('bracketed secret paste rejects delayed multiline content before any public prompt ' + splitMarker, async () => {
  const tty = terminal(); const prompt = tty.prompt();
  try {
    const pending = prompt.ask('密码', { secret: true });
    let completed = false;
    const denied = assert.rejects(pending, /多行/);
    void denied.catch(() => {});
    void pending.then(() => { completed = true; }, () => {});
    tty.input.write(splitMarker ? '\x1b[20' : '\x1b[200~');
    await new Promise(resolve => setTimeout(resolve, 20));
    tty.input.write((splitMarker ? '0~' : '') + 'FAKE_PASSWORD_HEAD');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(completed, false);
    tty.input.write('\r');
    await new Promise(resolve => setTimeout(resolve, 20));
    tty.input.write('FAKE_PASSWORD_TAIL\x1b[201~');
    await denied;
    await assert.rejects(prompt.ask('公开问题'), /取消/);
    assert.equal(completed, false);
    assert.ok(!tty.transcript().includes('FAKE_PASSWORD'));
  } finally { prompt.close(); tty.input.destroy(); tty.output.destroy(); }
  assert.equal(tty.input.isRaw, false);
  assert.equal(tty.input.isPaused(), true);
  assert.ok(tty.transcript().includes('\x1b[?2004l'));
});

test('bracketed single-line secret paste preserves split UTF-8 and requires explicit Enter', async () => {
  const tty = terminal(); const prompt = tty.prompt();
  try {
    const secret = '  fixture-隐藏  ';
    let completed = false;
    const pending = prompt.ask('密码', { secret: true });
    void pending.then(() => { completed = true; });
    const paste = Buffer.from('\x1b[200~' + secret + '\x1b[201~');
    for (const byte of paste) tty.input.write(Buffer.from([byte]));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, false);
    tty.input.write('\r');
    assert.equal(await pending, secret);
    assert.ok(!tty.transcript().includes('fixture'));
    assert.ok(tty.transcript().includes('\x1b[?2004h'));
  } finally { prompt.close(); tty.input.destroy(); tty.output.destroy(); }
});
