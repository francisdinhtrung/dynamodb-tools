// Runs against DynamoDB Local when DDB_ENDPOINT_URL is set: npm run local:up && npm run test:local
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { run, makeClient } from '../src/cli.js';
import { seed, TABLE } from '../scripts/seed-local.js';

const skip = !process.env.DDB_ENDPOINT_URL && 'DDB_ENDPOINT_URL not set';

async function ddb(...args) {
  let out = '', err = '';
  const code = await run(args, { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) } });
  return { code, json: out ? JSON.parse(out) : null, err: err ? JSON.parse(err) : null };
}

before(async () => {
  if (!skip) await seed(makeClient({}));
});

test('list-tables', { skip }, async () => {
  const { json } = await ddb('list-tables');
  assert.ok(json.tables.includes(TABLE));
});

test('describe resolves keys and GSI', { skip }, async () => {
  const { json } = await ddb('describe', TABLE);
  assert.deepEqual(json.pk, { name: 'pk', type: 'S' });
  assert.equal(json.gsi[0].name, 'GSI1');
  assert.equal(json.gsi[0].pk.name, 'gsi1pk');
});

test('get item', { skip }, async () => {
  const { json } = await ddb('get', TABLE, '--key', '{"pk":"USER#1","sk":"PROFILE"}');
  assert.equal(json.item.name, 'An');
  const kv = await ddb('get', TABLE, '--key', 'pk=USER#1,sk=PROFILE');
  assert.equal(kv.json.item.name, 'An');
  const bad = await ddb('get', TABLE, '--key', 'nope=1');
  assert.equal(bad.code, 2);
});

test('query with begins_with, desc, pagination', { skip }, async () => {
  const p1 = await ddb('query', TABLE, '--pk', 'USER#1', '--sk-begins', 'ORDER#', '--desc', '--limit', '2');
  assert.equal(p1.json.items.length, 2);
  assert.equal(p1.json.items[0].sk, 'ORDER#2026-03-15');
  assert.ok(p1.json.nextToken);
  const p2 = await ddb('query', TABLE, '--pk', 'USER#1', '--sk-begins', 'ORDER#', '--desc', '--limit', '2', '--next-token', p1.json.nextToken);
  assert.deepEqual(p2.json.items.map((i) => i.sk), ['ORDER#2026-01-05']);
  assert.deepEqual(p2.json.items[0].tags.sort(), ['gift', 'vip']);
});

test('query between and GSI', { skip }, async () => {
  const r = await ddb('query', TABLE, '--pk', 'USER#1', '--sk-from', 'ORDER#2026-02', '--sk-to', 'ORDER#2026-12');
  assert.equal(r.json.count, 2);
  const g = await ddb('query', TABLE, '--index', 'GSI1', '--pk', 'EMAIL#binh@example.com');
  assert.equal(g.json.items[0].name, 'Binh');
});

test('scan with projection and redact', { skip }, async () => {
  const { json } = await ddb('scan', TABLE, '--projection', 'pk,email', '--redact', 'email', '--limit', '50');
  assert.equal(json.count, 5);
  const user = json.items.find((i) => i.email);
  assert.equal(user.email, '[REDACTED]');
  assert.deepEqual(Object.keys(user).sort(), ['email', 'pk']);
});

test('sample infers shape', { skip }, async () => {
  const { json } = await ddb('sample', TABLE, '-n', '5');
  assert.equal(json.attributes.pk.present, 5);
});

test('AWS errors exit 1', { skip }, async () => {
  const r = await ddb('describe', 'nope');
  assert.equal(r.code, 1);
  assert.equal(r.err.error, 'ResourceNotFoundException');
});
