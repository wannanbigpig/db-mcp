import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { BoundedStdioTransport } from '../runtime/stdio.js';

const frame = (id: number, padding = 'x'.repeat(600)) => JSON.stringify({
  jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'list_sources', arguments: {}, _meta: { padding } },
}) + '\n';

test('stdio budgets each message, including coalesced frames and a split Unicode frame', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const transport = new BoundedStdioTransport(input, output, 1024);
  const messages: unknown[] = [], errors: Error[] = [];
  transport.onmessage = message => { messages.push(message); };
  transport.onerror = error => { errors.push(error); };
  try {
    await transport.start();
    input.write(frame(1) + frame(2));
    const third = Buffer.from(frame(3, '中文'));
    const split = third.indexOf(Buffer.from('中')) + 1;
    input.write(third.subarray(0, split));
    input.write(Buffer.concat([third.subarray(split), Buffer.from(frame(4))]));
    assert.deepEqual(messages, [1, 2, 3, 4].map(id => JSON.parse(frame(id, id === 3 ? '中文' : undefined))));
    assert.deepEqual(errors, []);
  } finally { await transport.close(); input.destroy(); output.destroy(); }
});

test('stdio rejects one oversized frame even when its prefix follows a complete message', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const transport = new BoundedStdioTransport(input, output, 1024);
  let received = 0, errors = 0, closed = 0;
  transport.onmessage = () => { received++; };
  transport.onerror = () => { errors++; };
  transport.onclose = () => { closed++; };
  try {
    await transport.start();
    input.write(frame(1) + 'x'.repeat(300));
    assert.equal(received, 1); assert.equal(closed, 0);
    input.write('x'.repeat(725));
    assert.equal(errors, 1); assert.equal(closed, 1);
    input.write(frame(2));
    assert.equal(received, 1);
    await transport.close(); assert.equal(closed, 1);
  } finally { await transport.close(); input.destroy(); output.destroy(); }
});

test('stdio reports a malformed line and still accepts the following valid frame', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const transport = new BoundedStdioTransport(input, output, 1024);
  let received = 0, errors = 0;
  transport.onmessage = () => { received++; };
  transport.onerror = () => { errors++; };
  try {
    await transport.start(); input.write('not-json\n' + frame(1));
    assert.equal(errors, 1); assert.equal(received, 1);
  } finally { await transport.close(); input.destroy(); output.destroy(); }
});

test('stdio close rejects a send waiting for a stalled output and detaches listeners', async () => {
  const input = new PassThrough();
  const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _callback) {} });
  const transport = new BoundedStdioTransport(input, output, 1024);
  let deadline: NodeJS.Timeout | undefined;
  try {
    await transport.start();
    const sending = assert.rejects(transport.send({ jsonrpc: '2.0', id: 1, result: {} }), /SERVER_CLOSED/);
    await transport.close();
    await Promise.race([sending, new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('send still pending after transport close')), 500);
    })]);
    assert.equal(input.listenerCount('data'), 0); assert.equal(output.listenerCount('drain'), 0);
  } finally { clearTimeout(deadline); await transport.close(); input.destroy(); output.destroy(); }
});
