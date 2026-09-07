import assert from 'node:assert/strict';
import test from 'node:test';
import { createFingerprint, stableStringify } from '../lib/canonical.js';

test('fingerprints ignore object key order', () => {
  assert.equal(createFingerprint({ a: 1, b: 2 }), createFingerprint({ b: 2, a: 1 }));
});

test('fingerprints preserve array order', () => {
  assert.notEqual(createFingerprint({ values: [1, 2] }), createFingerprint({ values: [2, 1] }));
});

test('stableStringify canonicalizes nested objects', () => {
  assert.equal(
    stableStringify({ z: { b: true, a: null }, a: 'first' }),
    '{"a":"first","z":{"a":null,"b":true}}'
  );
});
