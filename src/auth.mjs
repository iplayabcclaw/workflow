import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const TOKEN_TTL_SECONDS = Number(process.env.AUTH_TOKEN_TTL_SECONDS || 60 * 60 * 24 * 7);
const COOKIE_NAME = 'h3_session';

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function sign(value) {
  return createHmac('sha256', process.env.AUTH_SECRET || '').update(value).digest('base64url');
}

export function authIsConfigured() {
  return Boolean(process.env.AUTH_SECRET && process.env.INITIAL_ADMIN_USERNAME && process.env.INITIAL_ADMIN_PASSWORD);
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${Buffer.from(hash).toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [algorithm, salt, expected] = String(stored || '').split('$');
  if (algorithm !== 'scrypt' || !salt || !expected) return false;
  const actual = Buffer.from(await scrypt(password, salt, 64));
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

export function createSessionToken(user) {
  if (!process.env.AUTH_SECRET) throw new Error('服务器未配置 AUTH_SECRET');
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ sub: user.id, username: user.username, role: user.role, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS }));
  return `${header}.${payload}.${sign(`${header}.${payload}`)}`;
}

export function parseSessionToken(token) {
  if (!process.env.AUTH_SECRET || !token) return null;
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) return null;
  const expected = sign(`${header}.${payload}`);
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return value.exp > Math.floor(Date.now() / 1000) ? value : null;
  } catch {
    return null;
  }
}

export function sessionCookie(token, maxAge = TOKEN_TTL_SECONDS) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function readSession(req) {
  const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').map(item => item.trim().split(/=(.*)/s, 2)).filter(([key]) => key));
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  return parseSessionToken(cookies[COOKIE_NAME] || bearer);
}

export function publicUser(user) {
  return { id: user.id, username: user.username, display_name: user.display_name, role: user.role, points_balance: Number(user.points_balance || 0), created_at: user.created_at };
}
