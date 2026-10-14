import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marshall } from '@aws-sdk/util-dynamodb';
import {
  UsageError, assertTableAllowed, decodeToken, encodeToken, inferShape, keyValue, parseLimit, redact, toPlain,
} from '../src/util.js';
import { run } from '../src/cli.js';

test('parseLimit defaults and caps', () => {
  assert.equal(parseLimit(undefined), 20);
  assert.equal(parseLimit('500'), 100);
  assert.throws(() => parseLimit('0'), UsageError);
  assert.throws(() => parseLimit('abc'), UsageError);
});

test('token roundtrip keeps binary values', () => {
  const lek = { pk: { S: 'A' }, bin: { B: new Uint8Array([1, 2, 3]) } };
  assert.deepEqual(decodeToken(encodeToken(lek)), lek);
  assert.equal(encodeToken(undefined), null);
  assert.throws(() => decodeToken('%%%'), UsageError);
});

test('toPlain converts sets, binary and big numbers', () => {
  const raw = marshall({ s: new Set(['a']), n: 1.5, i: 7 });
  raw.b = { B: new Uint8Array([255]) };
  raw.big = { N: '123456789012345678901234567890' };
  assert.deepEqual(toPlain(raw), { s: ['a'], n: 1.5, i: 7, b: { $binary: '/w==' }, big: '123456789012345678901234567890' });
});

test('redact works at any depth', () => {
  assert.deepEqual(redact({ email: 'x', a: [{ email: 'y', ok: 1 }] }, new Set(['email'])), {
    email: '[REDACTED]',
    a: [{ email: '[REDACTED]', ok: 1 }],
  });
});

test('table allowlist supports prefix', () => {
  assert.doesNotThrow(() => assertTableAllowed('app-dev-users', 'orders,app-dev-*'));
  assert.doesNotThrow(() => assertTableAllowed('orders', 'orders,app-dev-*'));
  assert.throws(() => assertTableAllowed('app-prod-users', 'orders,app-dev-*'), UsageError);
  assert.doesNotThrow(() => assertTableAllowed('anything', ''));
});

test('keyValue validates number keys', () => {
  assert.deepEqual(keyValue('42', 'N', 'id'), { N: '42' });
  assert.throws(() => keyValue('x', 'N', 'id'), UsageError);
  assert.deepEqual(keyValue('x', 'S', 'id'), { S: 'x' });
});

test('inferShape counts attribute types', () => {
  const shape = inferShape([marshall({ a: 1, b: 'x' }), marshall({ a: 'y' })]);
  assert.deepEqual(shape, { a: { types: ['N', 'S'], present: 2 }, b: { types: ['S'], present: 1 } });
});

function capture() {
  let out = '';
  return { write: (s) => (out += s), get text() { return out; } };
}

test('cli usage errors go to stderr as JSON with exit 2', async () => {
  const stdout = capture(), stderr = capture();
  assert.equal(await run(['bogus'], { stdout, stderr }), 2);
  assert.equal(JSON.parse(stderr.text).error, 'UsageError');
  assert.equal(await run(['query'], { stdout, stderr }), 2);
  assert.equal(await run(['--help'], { stdout, stderr }), 0);
  assert.match(stdout.text, /USAGE/);
});
