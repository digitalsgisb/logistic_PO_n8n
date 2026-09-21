import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const keyLength = 32;

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, keyLength).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, encoded: string) {
  const [algorithm, salt, expectedHex] = encoded.split('$');
  if (algorithm !== 'scrypt' || !salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  if (expected.length !== keyLength) return false;
  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(actual, expected);
}

export function validUsername(username: string) {
  return /^[A-Za-z0-9._-]{3,32}$/.test(username);
}

export function validPassword(password: string) {
  return password.length >= 12 && password.length <= 200;
}
