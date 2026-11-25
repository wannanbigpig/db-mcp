import test from 'node:test';
import assert from 'node:assert/strict';
import { withTimeout } from '../utils/async.js';
import { ConcurrencyLimiter } from '../utils/concurrency.js';

test('withTimeout rejects slow operations', async () => {
  await assert.rejects(
    withTimeout(
      new Promise((resolve) => setTimeout(resolve, 30)),
      5,
      'timeout'
    ),
    /timeout/
  );
});

test('ConcurrencyLimiter queues tasks beyond configured concurrency', async () => {
  const limiter = new ConcurrencyLimiter(1);
  const order: string[] = [];

  await Promise.all([
    limiter.run(async () => {
      order.push('start-1');
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push('end-1');
    }),
    limiter.run(async () => {
      order.push('start-2');
      order.push('end-2');
    }),
  ]);

  assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2']);
  assert.deepEqual(limiter.snapshot(), { active: 0, queued: 0, maxConcurrent: 1, maxQueued: 100 });
});

test('timed out work keeps its concurrency slot until the underlying operation ends', async () => {
  const limiter = new ConcurrencyLimiter(1);
  let finish!: () => void;
  const operation = new Promise<void>((resolve) => { finish = resolve; });
  const result = limiter.runWithTimeout(() => operation, 5, 'timeout');
  await assert.rejects(result, /timeout/);
  assert.equal(limiter.snapshot().active, 1);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(limiter.snapshot().active, 0);
});

test('queued work times out without running and the queue rejects overflow', async () => {
  const limiter = new ConcurrencyLimiter(1, 1);
  let finish!: () => void;
  const blocker = limiter.run(() => new Promise<void>((resolve) => { finish = resolve; }));
  let ran = false;
  const queued = limiter.runWithTimeout(async () => { ran = true; }, 5, 'queue timeout');
  await assert.rejects(limiter.run(async () => undefined), /队列已满/);
  await assert.rejects(queued, /queue timeout/);
  assert.equal(ran, false);
  assert.equal(limiter.snapshot().queued, 0);
  finish();
  await blocker;
});

for (const full of ['instance', 'source'] as const) test('joint admission enforces the ' + full + ' queue limit and cancels both queue entries', async () => {
  const global = new ConcurrencyLimiter(2, full === 'instance' ? 1 : 4);
  const source = new ConcurrencyLimiter(1, full === 'source' ? 1 : 4);
  const controller = new AbortController();
  let finish = () => {}, started = () => {}, ran = false;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const blocker = global.runCancellable(() => new Promise<void>(resolve => { finish = resolve; started(); }),
    new AbortController().signal, 1000, source);
  await entered;
  const queued = global.runCancellable(async () => { ran = true; }, controller.signal, 1000, source);
  const cancelled = assert.rejects(queued, /REQUEST_CANCELLED/);
  try {
    assert.equal(global.snapshot().active, 1); assert.equal(source.snapshot().active, 1);
    assert.equal(global.snapshot().queued, 1); assert.equal(source.snapshot().queued, 1);
    await assert.rejects(global.runCancellable(async () => {}, new AbortController().signal, 1000, source), /BUDGET_EXCEEDED/);
    // An eligible source does not have to join the full pending queue.
    await global.runCancellable(async () => {}, new AbortController().signal, 1000, new ConcurrencyLimiter(1));
    controller.abort(); await cancelled;
    assert.equal(global.snapshot().queued, 0); assert.equal(source.snapshot().queued, 0);
  } finally { controller.abort(); finish(); await blocker; await cancelled; }
  assert.equal(ran, false); assert.equal(global.snapshot().active, 0); assert.equal(source.snapshot().active, 0);
});

for (const occupied of ['instance', 'source'] as const) test('joint admission waits without reserving the other permit: ' + occupied, async () => {
  const global = new ConcurrencyLimiter(1), source = new ConcurrencyLimiter(1);
  const holder = occupied === 'instance' ? global : source;
  const controller = new AbortController();
  let finish = () => {}, started = () => {};
  const entered = new Promise<void>(resolve => { started = resolve; });
  const blocker = holder.run(() => new Promise<void>(resolve => { finish = resolve; started(); }));
  await entered;
  const queued = global.runCancellable(async () => 'completed', controller.signal, 1000, source);
  try {
    assert.equal((occupied === 'instance' ? source : global).snapshot().active, 0);
    finish(); await blocker;
    assert.equal(await queued, 'completed');
    controller.abort(); // No resolved waiter's abort listener may remain attached.
    assert.equal(global.snapshot().active, 0); assert.equal(source.snapshot().active, 0);
    assert.equal(global.snapshot().queued, 0); assert.equal(source.snapshot().queued, 0);
  } finally { finish(); await blocker; await queued; }
});

test('joint queue timeout removes both waiters without running later', async () => {
  const global = new ConcurrencyLimiter(2), source = new ConcurrencyLimiter(1);
  let finish = () => {}, started = () => {}, ran = false;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const blocker = source.run(() => new Promise<void>(resolve => { finish = resolve; started(); }));
  await entered;
  try {
    await assert.rejects(global.runCancellable(async () => { ran = true; }, new AbortController().signal, 5, source), /REQUEST_CANCELLED/);
    assert.equal(global.snapshot().queued, 0); assert.equal(source.snapshot().queued, 0);
  } finally { finish(); await blocker; }
  assert.equal(ran, false); assert.equal(global.snapshot().active, 0);
});

test('joint admission retains both active permits until cancelled work actually settles', async () => {
  const global = new ConcurrencyLimiter(2), source = new ConcurrencyLimiter(1);
  const controller = new AbortController();
  let finish = () => {}, started = () => {};
  const entered = new Promise<void>(resolve => { started = resolve; });
  const work = global.runCancellable(() => new Promise<void>(resolve => { finish = resolve; started(); }), controller.signal, 1000, source);
  await entered;
  try {
    controller.abort();
    assert.equal(global.snapshot().active, 1); assert.equal(source.snapshot().active, 1);
    await assert.rejects(global.runCancellable(async () => {}, new AbortController().signal, 5, source), /REQUEST_CANCELLED/);
  } finally { finish(); await work; }
  assert.equal(global.snapshot().active, 0); assert.equal(source.snapshot().active, 0);
});
