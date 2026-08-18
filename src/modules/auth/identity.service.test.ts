import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeEmail } from '../../lib/canonical.js';

test('normalizeEmail trims and lowercases identities', () => {
  assert.equal(normalizeEmail('  USER@Example.COM '), 'user@example.com');
});

test('normalizeEmail converts empty values to null', () => {
  assert.equal(normalizeEmail('  '), null);
  assert.equal(normalizeEmail(undefined), null);
});
