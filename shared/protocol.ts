import { SignJWT, importJWK, exportJWK, generateKeyPair, jwtVerify, decodeProtectedHeader, calculateJwkThumbprint, type JWK, type JWTPayload } from 'jose';

export const JWT_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
export const CLIENT_ASSERTION = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
export const SCOPES = ['poppy:read', 'poppy:write'];
export const now = () => Math.floor(Date.now() / 1000);
export const id = (prefix = '') => prefix + crypto.randomUUID().replaceAll('-', '');
export function randomSecret() { return b64(crypto.getRandomValues(new Uint8Array(32))); }
export function b64(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
export async function hash(value: string) { return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))); }
export type KeyPair = { private: JWK; public: JWK };
export async function keyPair(): Promise<KeyPair> {
  const keys = await generateKeyPair('ES256', { extractable: true });
  return { private: await exportJWK(keys.privateKey), public: await exportJWK(keys.publicKey) };
}
export async function sign(payload: JWTPayload, keys: KeyPair, typ = 'JWT', dpop = false) {
  return new SignJWT(payload).setProtectedHeader({ alg: 'ES256', typ, ...(dpop ? { jwk: keys.public } : { kid: 'agent-key-1' }) })
    .sign(await importJWK(keys.private, 'ES256'));
}
export function claims(issuer: string, subject: string, audience: string): JWTPayload {
  return { iss: issuer, sub: subject, aud: audience, iat: now(), exp: now() + 60, jti: id() };
}
export function target(url: string) { const u = new URL(url); u.search = ''; u.hash = ''; return u.href; }
export async function proof(keys: KeyPair, method: string, url: string, token?: string, nonce?: string) {
  return sign({ jti: id(), htm: method, htu: target(url), iat: now(), ...(token ? { ath: await hash(token) } : {}), ...(nonce ? { nonce } : {}) }, keys, 'dpop+jwt', true);
}
export class ProtocolError extends Error {
  constructor(public code: string, public status = 400, public extra: Record<string, unknown> = {}) { super(code); }
}
export function fail(code: string, status = 400, extra: Record<string, unknown> = {}): never { throw new ProtocolError(code, status, extra); }
export function json(body: unknown, status = 200, headers: HeadersInit = {}) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}
export function errorResponse(error: unknown, challenge = false) {
  const e = error instanceof ProtocolError ? error : new ProtocolError('server_error', 500);
  const headers: Record<string, string> = {};
  if (challenge || ['invalid_token', 'invalid_dpop_proof', 'sign_in_required', 'insufficient_scope'].includes(e.code)) {
    headers['WWW-Authenticate'] = `DPoP error="${e.code}"${e.extra.scope ? `, scope="${e.extra.scope}"` : ''}`;
  }
  return json({ error: e.code, ...e.extra }, e.status, headers);
}
export function permittedUrl(raw: string, local: boolean) {
  const url = new URL(raw);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(local && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) fail('invalid_metadata');
  return url;
}
export async function readText(response: Response | Request, limit = 65536) {
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > limit) { await reader.cancel(); fail('request_too_large', 413); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}
export async function bodyJson(request: Request): Promise<Record<string, unknown>> {
  try { const body: unknown = JSON.parse(await readText(request)); if (!body || typeof body !== 'object' || Array.isArray(body)) fail('invalid_request'); return body as Record<string, unknown>; }
  catch (e) { if (e instanceof ProtocolError) throw e; fail('invalid_request'); }
}
export async function formBody(request: Request) {
  const p = new URLSearchParams(await readText(request)); const seen = new Set<string>();
  for (const [name] of p) { if (seen.has(name)) fail('invalid_request'); seen.add(name); } return p;
}
export function scopes(raw: string | null, allowed = SCOPES): string[] {
  if (!raw?.trim()) fail('invalid_scope');
  const list = [...new Set(raw.split(' '))]; if (list.some(s => !allowed.includes(s))) fail('invalid_scope'); return list;
}
export async function verifyAssertion(jwt: string, keys: JWK[], issuer: string, audience: string, expectedSubject?: string) {
  try {
    const header = decodeProtectedHeader(jwt); if (header.alg !== 'ES256' || header.typ !== 'JWT') fail('invalid_grant');
    const jwk = keys.find(k => k.kid === header.kid); if (!jwk || jwk.d) fail('invalid_grant');
    const { payload } = await jwtVerify(jwt, await importJWK(jwk, 'ES256'), { algorithms: ['ES256'], issuer, audience, clockTolerance: 5, requiredClaims: ['iat', 'exp', 'jti', 'sub'] });
    if (payload.aud !== audience || typeof payload.sub !== 'string' || !payload.sub || !payload.jti || !payload.iat || !payload.exp || payload.exp - payload.iat > 60 || payload.iat > now() + 5 || payload.iat < now() - 65 || (expectedSubject && payload.sub !== expectedSubject)) fail('invalid_grant');
    return payload;
  } catch { fail('invalid_grant'); }
}
export async function verifyProof(request: Request, token?: string) {
  try {
    const jwt = request.headers.get('DPoP'); if (!jwt) fail('invalid_dpop_proof');
    const header = decodeProtectedHeader(jwt);
    if (header.typ !== 'dpop+jwt' || header.alg !== 'ES256' || !header.jwk || ('d' in header.jwk) || header.jwk.kty !== 'EC' || header.jwk.crv !== 'P-256') fail('invalid_dpop_proof');
    const { payload } = await jwtVerify(jwt, await importJWK(header.jwk, 'ES256'), { algorithms: ['ES256'], requiredClaims: ['jti', 'iat'] });
    if (payload.htm !== request.method || payload.htu !== target(request.url) || typeof payload.iat !== 'number' || Math.abs(now() - payload.iat) > 60 || typeof payload.jti !== 'string' || !payload.jti || (token && payload.ath !== await hash(token)) || (!token && payload.ath !== undefined)) fail('invalid_dpop_proof');
    return { thumbprint: await calculateJwkThumbprint(header.jwk), jti: payload.jti };
  } catch { fail('invalid_dpop_proof', token ? 401 : 400); }
}
export function cookie(request: Request, name: string) {
  return request.headers.get('Cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith(name + '='))?.slice(name.length + 1);
}
export function escape(value: string) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }
export function securityHeaders(response: Response) {
  // Service and static-asset responses may have immutable headers.
  response = new Response(response.body, response);
  response.headers.set('X-Content-Type-Options', 'nosniff'); response.headers.set('Referrer-Policy', 'strict-origin');
  response.headers.set('X-Frame-Options', 'DENY'); return response;
}
export type RpcResult = { status: number; body: Record<string, unknown> };
export type Message = { id: string; sender: 'agent' | 'human'; text?: string; data?: Record<string, unknown>; context?: Record<string, unknown> };
export type Event = { id: string; type: string; created_at: string; [key: string]: unknown };
export type TokenResponse = { access_token: string; token_type: 'DPoP'; expires_in: number; scope: string; session_id: string; signed_in: boolean; refresh_token?: string; refresh_token_expires_in?: number };
