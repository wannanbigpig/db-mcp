import test from 'node:test';
import assert from 'node:assert/strict';
import { BSON, type Document, type FindOptions, type MongoClient } from 'mongodb';
import { parseV2Config } from '../config/v2.js';
import { mongoPreview, mongoWrite } from '../runtime/adapters/mongodb.js';
import type { MongoWritePlan } from '../runtime/write-policy.js';

const source = parseV2Config({
  version: 2,
  instance: { name: 'mongo-version', environment: 'test', transport: 'stdio', tier: 'read_write', journal: { directory: '/tmp/db-mcp-mongo-version-fixture' } },
  sources: [{ id: 'mongo', engine: 'mongodb', database: 'test', connectionStringRef: 'env:UNUSED_FIXTURE',
    tls: { mode: 'disabled' }, access: { tier: 'read_write', collections: ['items'], fields: { items: ['_id', 'version', 'name'] },
      writes: { collections: { items: { versionColumn: 'version', writableColumns: ['name'], allowUpdate: true } } } } }],
}).sources[0];
assert.equal(source.engine, 'mongodb');

const plan: MongoWritePlan = {
  engine: 'mongodb', tool: 'mongodb_prepare_write', sourceId: 'mongo', target: 'items',
  action: 'update', key: { _id: 'item' }, versionColumn: 'version', expectedVersion: 7, values: { name: 'next' },
};

function versionFixture(version: unknown, unchanged = false) {
  let document = BSON.serialize({ version });
  const collection = {
    listIndexes: () => ({
      async *[Symbol.asyncIterator]() { yield { name: '_id_', key: { _id: 1 } }; },
      close: async () => {},
    }),
    findOne: async (filter: Document, options: FindOptions) => {
      if (filter.$expr) return unchanged ? { _id: 'item' } : null;
      return BSON.deserialize(document, options);
    },
  };
  const db = {
    collection: () => collection,
    listCollections: () => ({ toArray: async () => [{ type: 'collection', info: { uuid: 'fixture' } }] }),
    admin: () => ({ command: async () => ({ ok: 1 }) }),
  };
  const client = {
    db: () => db,
    startSession: () => ({ startTransaction() {}, endSession: async () => {} }),
  } as unknown as MongoClient;
  return { client, setVersion(value: unknown) { document = BSON.serialize({ version: value }); } };
}

test('MongoDB write preview rejects invalid stored versions without coercing values', async () => {
  const fixture = versionFixture(7);
  const signal = new AbortController().signal;
  for (const [label, version] of [
    ['string', '7'],
    ['array', [7]],
    ['date', new Date(7)],
    ['non-integer double', 7.25],
    ['decimal', BSON.Decimal128.fromString('7.0000000000000000001')],
    ['negative', -7],
    ['out-of-range long', BSON.Long.fromBigInt(BigInt(Number.MAX_SAFE_INTEGER) + 1n)],
  ] as const) {
    fixture.setVersion(version);
    await assert.rejects(mongoPreview(fixture.client, source, plan, signal), { code: 'SCHEMA_UNSAFE' }, label);
  }

  fixture.setVersion(true);
  await assert.rejects(mongoPreview(fixture.client, source, { ...plan, expectedVersion: 1 }, signal), { code: 'SCHEMA_UNSAFE' });
});

test('MongoDB commit rejects a malformed stored version introduced after preview before sending a write', async () => {
  const fixture = versionFixture(7);
  const signal = new AbortController().signal;
  const preview = await mongoPreview(fixture.client, source, plan, signal);
  assert.equal(preview.condition, 'match');
  fixture.setVersion('7');
  let attempts = 0;
  const result = await mongoWrite(fixture.client, source, plan, preview.fingerprint, signal, {
    sent() { attempts++; assert.fail('A malformed version reached the write boundary'); },
  });
  assert.equal(attempts, 0);
  assert.deepEqual(result, { state: 'not_started', code: 'SCHEMA_UNSAFE' });
});

test('MongoDB safe integer versions retain exact matches and the Long version ceiling', async () => {
  const signal = new AbortController().signal;
  for (const version of [new BSON.Int32(7), new BSON.Double(7), BSON.Long.fromBigInt(7n)]) {
    const fixture = versionFixture(version);
    assert.equal((await mongoPreview(fixture.client, source, plan, signal)).condition, 'match');
    assert.equal((await mongoPreview(fixture.client, source, { ...plan, expectedVersion: 8 }, signal)).condition, 'conflict');
  }
  const ceiling = Number.MAX_SAFE_INTEGER;
  const planAtCeiling = { ...plan, expectedVersion: ceiling };
  const valueAtCeiling = BSON.Long.fromBigInt(BigInt(ceiling));
  const fixture = versionFixture(valueAtCeiling, true);
  const preview = await mongoPreview(fixture.client, source, planAtCeiling, signal);
  assert.equal(preview.condition, 'match');
  const rejectWrite = { sent() { assert.fail('A version at the ceiling should not send an update'); } };
  assert.deepEqual(await mongoWrite(fixture.client, source, planAtCeiling, preview.fingerprint, signal, rejectWrite),
    { state: 'success', directAffected: 0, effect: 'no_change', version: ceiling });
  const changed = versionFixture(valueAtCeiling);
  assert.deepEqual(await mongoWrite(changed.client, source, planAtCeiling, preview.fingerprint, signal, rejectWrite),
    { state: 'not_started', code: 'VERSION_LIMIT_REACHED' });
});
