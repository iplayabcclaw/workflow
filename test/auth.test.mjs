import assert from 'node:assert/strict';
import test from 'node:test';

process.env.AUTH_SECRET = 'test-secret-that-is-not-for-production';
const { createSessionToken, hashPassword, parseSessionToken, verifyPassword } = await import('../src/auth.mjs');

test('password hashes verify without exposing the password', async () => {
  const hash = await hashPassword('a-secure-password');
  assert.notEqual(hash, 'a-secure-password');
  assert.equal(await verifyPassword('a-secure-password', hash), true);
  assert.equal(await verifyPassword('wrong-password', hash), false);
});

test('signed sessions reject tampering', () => {
  const token = createSessionToken({ id: 42, username: 'demo', role: 'user' });
  assert.equal(parseSessionToken(token).sub, 42);
  assert.equal(parseSessionToken(`${token}x`), null);
});
