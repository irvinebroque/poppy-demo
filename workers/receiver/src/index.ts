import type { JWK } from 'jose';
import { JWT_GRANT, CLIENT_ASSERTION, SCOPES, fail, json, errorResponse, hash, randomSecret, now, scopes, verifyAssertion, verifyProof, permittedUrl, formBody, bodyJson, readText, cookie, securityHeaders, type Message, type RpcResult } from '../../../shared/protocol';
import { CompanyUser, ReplayGuard, type Input } from './state';
import { storePage, consentPage, productPage } from './ui';
export { CompanyUser, ReplayGuard };

type Client = { client_id: string; client_name: string; jwks_uri: string; redirect_uris: string[]; token_endpoint_auth_method: string };
const clientId = (env: ReceiverEnv) => env.CALLER_ORIGIN + '/agent.json';
function guard(env: ReceiverEnv, key: string) { return env.GUARDS.getByName(key); }
async function client(env: ReceiverEnv, value: string): Promise<{ metadata: Client; keys: JWK[] }> {
  // This demo is explicitly registered to one peer; never fetch arbitrary client-provided URLs.
  if (value !== clientId(env)) fail('invalid_client', 401);
  const response = await env.CALLER.fetch(value);
  if (!response.ok) fail('invalid_client', 401);
  const metadata = JSON.parse(await readText(response)) as Client;
  if (metadata.client_id !== value || metadata.jwks_uri !== env.CALLER_ORIGIN + '/jwks.json' || metadata.token_endpoint_auth_method !== 'private_key_jwt' || !Array.isArray(metadata.redirect_uris)) fail('invalid_client', 401);
  const origin = permittedUrl(value, env.LOCAL_DEMO === 'true').origin;
  if (metadata.redirect_uris.some(uri => permittedUrl(uri, env.LOCAL_DEMO === 'true').origin !== origin)) fail('invalid_client', 401);
  const keyResponse = await env.CALLER.fetch(metadata.jwks_uri);
  if (!keyResponse.ok) fail('invalid_client', 401);
  const jwks = JSON.parse(await readText(keyResponse)) as { keys: JWK[] };
  if (!Array.isArray(jwks.keys) || jwks.keys.some(k => !!k.d)) fail('invalid_client', 401);
  return { metadata, keys: jwks.keys };
}
async function authenticateClient(env: ReceiverEnv, p: URLSearchParams, audience: string) {
  const value = p.get('client_id') ?? ''; const { keys } = await client(env, value);
  if (p.get('client_assertion_type') !== CLIENT_ASSERTION) fail('invalid_client', 401);
  let payload;
  try { payload = await verifyAssertion(p.get('client_assertion') ?? '', keys, value, audience, value); }
  catch { fail('invalid_client', 401); }
  if (!await guard(env, 'assertions:' + value).accept(payload.jti!, payload.exp! + 5)) fail('invalid_client', 401);
  return { value, keys };
}
async function checkProof(env: ReceiverEnv, request: Request, token?: string) {
  const p = await verifyProof(request, token);
  if (!await guard(env, 'dpop:' + p.thumbprint).accept(p.jti, now() + 65)) fail('invalid_dpop_proof', token ? 401 : 400);
  return p.thumbprint;
}
function ownerFromToken(env: ReceiverEnv, token: string) {
  const [owner, secret, extra] = token.split('.'); if (!/^[a-f0-9]{64}$/.test(owner ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(secret ?? '') || extra) fail('invalid_token', 401);
  return env.OWNERS.get(env.OWNERS.idFromString(owner));
}
async function dispatch(owner: DurableObjectStub<CompanyUser>, action: string, input: Input): Promise<RpcResult> { return JSON.parse(await owner.dispatch(action, input)) as RpcResult; }
function output(result: RpcResult) {
  if (result.body.error) fail(String(result.body.error), result.status, Object.fromEntries(Object.entries(result.body).filter(([key]) => key !== 'error')));
  return json(result.body, result.status);
}
async function tokenEndpoint(request: Request, env: ReceiverEnv) {
  const p = await formBody(request); const endpoint = env.RECEIVER_ORIGIN + '/oauth/token';
  const auth = await authenticateClient(env, p, endpoint); const jkt = await checkProof(env, request);
  const grantType = p.get('grant_type'); let owner: DurableObjectStub<CompanyUser>; let action: string; let user: string | undefined; let grant: string | undefined; let replacement: string | undefined; let grantedScope: string[] | undefined;
  if (grantType === JWT_GRANT) {
    const payload = await verifyAssertion(p.get('assertion') ?? '', auth.keys, auth.value, endpoint);
    if (!await guard(env, 'assertions:' + auth.value).accept(payload.jti!, payload.exp! + 5)) fail('invalid_grant');
    user = payload.sub!; owner = env.OWNERS.getByName(auth.value + ':' + user); action = 'start';
  } else if (grantType === 'authorization_code') {
    const code = await guard(env, 'codes:' + auth.value).takeCode(await hash(p.get('code') ?? ''));
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(p.get('code_verifier') ?? '')) fail('invalid_grant');
    if (!code || Number(code.expires) < now() || code.redirect !== p.get('redirect_uri') || code.challenge !== await hash(p.get('code_verifier') ?? '')) fail('invalid_grant');
    if (!p.get('session_id')) fail('invalid_session');
    // Code exchange names a Session. The session route was recorded by the signed-out token request.
    const ownerId = await guard(env, 'session:' + p.get('session_id')).peekCode('route');
    if (!ownerId || ownerId.client !== auth.value) fail('invalid_session');
    owner = env.OWNERS.get(env.OWNERS.idFromString(String(ownerId.owner))); action = 'sign-in';
    replacement = owner.id.toString() + '.' + randomSecret(); grant = await hash(replacement); grantedScope = code.scope as string[];
  } else if (grantType === 'refresh_token') {
    const token = p.get('refresh_token') ?? ''; try { owner = ownerFromToken(env, token); } catch { fail('invalid_grant'); }
    grant = await hash(token); action = 'refresh';
  } else fail('unsupported_grant_type');
  const resource = p.get('resource') ?? undefined;
  if (resource && ![env.RECEIVER_ORIGIN + '/api', env.RECEIVER_ORIGIN + '/poppy/conversations'].includes(resource)) fail('invalid_target');
  const token = owner.id.toString() + '.' + randomSecret();
  const result = await dispatch(owner, action, { client: auth.value, user, session: p.get('session_id') ?? undefined, jkt, token, secret: await hash(token), grant, replacement, scope: p.has('scope') ? scopes(p.get('scope'), grantedScope ?? SCOPES) : grantedScope, resource });
  if (result.status === 200 && result.body.session_id) await guard(env, 'session:' + result.body.session_id).saveCode('route', { owner: owner.id.toString(), client: auth.value });
  return output(result);
}
async function authorize(request: Request, env: ReceiverEnv) {
  const issuer = env.RECEIVER_ORIGIN;
  if (request.method === 'GET') {
    const p = new URL(request.url).searchParams;
    const { metadata } = await client(env, p.get('client_id') ?? '');
    const redirect = p.get('redirect_uri') ?? ''; if (!metadata.redirect_uris.includes(redirect)) fail('invalid_redirect_uri');
    if (p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.get('code_challenge') ?? '') || !p.get('state')) fail('invalid_request');
    const scope = scopes(p.get('scope')); const nonce = randomSecret();
    await guard(env, 'consent').saveCode(await hash(nonce), { client: metadata.client_id, redirect, state: p.get('state'), challenge: p.get('code_challenge') ?? '', scope, expires: now() + 600 });
    return new Response(consentPage(metadata.client_name, scope, nonce), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': `poppy_consent=${nonce}; HttpOnly; SameSite=Lax; Path=/oauth/authorize; Max-Age=600${env.LOCAL_DEMO === 'true' ? '' : '; Secure'}` } });
  }
  if (request.method !== 'POST') fail('method_not_allowed', 405);
  if (request.headers.get('Origin') !== issuer) fail('invalid_request');
  const p = await formBody(request); const nonce = p.get('consent_nonce') ?? '';
  if (!nonce || cookie(request, 'poppy_consent') !== nonce) fail('invalid_request');
  const details = await guard(env, 'consent').takeCode(await hash(nonce));
  if (!details || Number(details.expires) < now()) fail('invalid_request');
  const redirect = new URL(String(details.redirect)); redirect.searchParams.set('state', String(details.state)); redirect.searchParams.set('iss', issuer);
  if (p.get('decision') === 'approve') {
    const code = randomSecret(); const scope = SCOPES.filter(s => p.get(s) === 'yes');
    if (scope.some(s => !(details.scope as string[]).includes(s))) fail('invalid_scope');
    // Identity is a clearly labeled synthetic account; replace this step with real login in production.
    await guard(env, 'codes:' + details.client).saveCode(await hash(code), { ...details, scope, expires: now() + 60 });
    redirect.searchParams.set('code', code);
  } else redirect.searchParams.set('error', 'access_denied');
  return new Response(null, { status: 303, headers: { Location: redirect.href, 'Cache-Control': 'no-store', 'Set-Cookie': `poppy_consent=; Max-Age=0; Path=/oauth/authorize; HttpOnly; SameSite=Lax${env.LOCAL_DEMO === 'true' ? '' : '; Secure'}` } });
}
function message(value: unknown): Message {
  if (!value || typeof value !== 'object') fail('invalid_request');
  const m = value as Message;
  if (typeof m.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(m.id) || !['agent','human'].includes(m.sender) || (!m.text && !m.data && !m.context) || (m.text !== undefined && typeof m.text !== 'string') || [m.data,m.context].some(v => v !== undefined && (!v || typeof v !== 'object' || Array.isArray(v)))) fail('invalid_request');
  if (m.context && ((m.context.locale !== undefined && typeof m.context.locale !== 'string') || (m.context.time_zone !== undefined && typeof m.context.time_zone !== 'string') || (m.context.user_available !== undefined && typeof m.context.user_available !== 'boolean'))) fail('invalid_request');
  return { id: m.id, sender: m.sender, ...(m.text !== undefined ? { text: m.text } : {}), ...(m.data ? { data: m.data } : {}), ...(m.context ? { context: m.context } : {}) };
}
async function handle(request: Request, env: ReceiverEnv): Promise<Response> {
  const url = new URL(request.url); const path = url.pathname; const origin = env.RECEIVER_ORIGIN;
  permittedUrl(origin, env.LOCAL_DEMO === 'true');
  if (path === '/' && request.method === 'GET') return new Response(storePage(env.CALLER_ORIGIN), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  if (path.startsWith('/products/') && request.method === 'GET') { const html = productPage(path.slice('/products/'.length), env.CALLER_ORIGIN); if (!html) fail('not_found',404); return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }); }
  if (path === '/.well-known/poppy.json' && request.method === 'GET') return json({ protocol_version: '0.1', organization: { name: 'Northstar Outfitters', domain: new URL(origin).hostname }, auth: { issuer: origin, direct: { scopes: SCOPES } }, agent: { protocols: [{ type: 'poppy', endpoint: origin + '/poppy/conversations' }] }, apis: [{ type: 'openapi', url: origin + '/openapi.json', description: 'Orders and jacket exchanges' }], web: {} }, 200, { 'Cache-Control': 'public, max-age=300' });
  if (path === '/.well-known/oauth-authorization-server' && request.method === 'GET') return json({ issuer: origin, poppy_domains: [new URL(origin).hostname], authorization_endpoint: origin + '/oauth/authorize', token_endpoint: origin + '/oauth/token', revocation_endpoint: origin + '/oauth/revoke', grant_types_supported: [JWT_GRANT, 'authorization_code', 'refresh_token'], response_types_supported: ['code'], token_endpoint_auth_methods_supported: ['private_key_jwt'], token_endpoint_auth_signing_alg_values_supported: ['ES256'], code_challenge_methods_supported: ['S256'], dpop_signing_alg_values_supported: ['ES256'], scopes_supported: SCOPES }, 200, { 'Cache-Control': 'public, max-age=300' });
  if (path === '/openapi.json' && request.method === 'GET') return json({ openapi: '3.1.0', info: { title: 'Northstar demo API', version: '0.1.0' }, servers: [{ url: origin }], security: [{ DPoP: [] }], components: { securitySchemes: { DPoP: { type: 'http', scheme: 'DPoP', description: 'Session Token with a DPoP proof (RFC 9449)' } } }, paths: { '/api/orders': { get: { operationId: 'listOrders', summary: 'List orders; requires poppy:read', responses: { '200': { description: 'Orders' }, '403': { description: 'Sign in or approve poppy:read' } } } }, '/api/orders/ord_1042/exchanges': { post: { operationId: 'exchangeJacket', summary: 'Exchange a jacket; requires poppy:write', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['replacement_sku'], properties: { replacement_sku: { type: 'string', enum: ['stormline-insulated-m'] } } } } } }, responses: { '201': { description: 'Exchange confirmed' }, '403': { description: 'Sign in or approve poppy:write' } } } } } });
  if (path === '/oauth/authorize') return authorize(request, env);
  if (path === '/oauth/token' && request.method === 'POST') return tokenEndpoint(request, env);
  if (path === '/oauth/revoke' && request.method === 'POST') {
    const p = await formBody(request); const auth = await authenticateClient(env, p, origin + '/oauth/revoke');
    const token = p.get('token') ?? '';
    try { const owner = ownerFromToken(env, token); await dispatch(owner, 'revoke', { client: auth.value, grant: await hash(token) }); } catch { /* RFC 7009: unknown tokens return success. */ }
    return json({});
  }
  if (!path.startsWith('/api/') && !path.startsWith('/poppy/conversations')) fail('not_found', 404);
  if (url.searchParams.has('access_token')) fail('invalid_token', 401);
  const header = request.headers.get('Authorization'); if (!header?.startsWith('DPoP ')) fail('invalid_token', 401);
  const token = header.slice(5); const jkt = await checkProof(env, request, token); const owner = ownerFromToken(env, token);
  const input: Input = { client: clientId(env), secret: await hash(token), jkt, resource: path.startsWith('/api/') ? origin + '/api' : origin + '/poppy/conversations' };
  if (path === '/api/orders' && request.method === 'GET') return output(await dispatch(owner, 'orders', input));
  if (path === '/api/orders/ord_1042/exchanges' && request.method === 'POST') { const b = await bodyJson(request); input.replacement = String(b.replacement_sku ?? ''); return output(await dispatch(owner, 'exchange', input)); }
  const match = path.match(/^\/poppy\/conversations(?:\/([A-Za-z0-9_-]{1,256})\/(messages|events|handoff|close))?$/);
  if (!match) fail('not_found', 404); input.conversation = match[1]; input.cursor = url.searchParams.get('cursor') ?? request.headers.get('Last-Event-ID') ?? undefined;
  if (!match[1] && request.method === 'POST') { const b = await bodyJson(request); input.message = message(b.message); if (b.parent_conversation_id !== undefined && typeof b.parent_conversation_id !== 'string') fail('invalid_request'); input.parent = b.parent_conversation_id as string | undefined; input.wait = url.searchParams.has('wait'); return output(await dispatch(owner, 'create', input)); }
  if (match[2] === 'events' && request.method === 'GET') return output(await dispatch(owner, 'events', input));
  if (request.method !== 'POST') fail('method_not_allowed', 405);
  const b = await bodyJson(request);
  if (match[2] === 'messages') { input.message = message(b.message); input.wait = url.searchParams.has('wait'); return output(await dispatch(owner, 'message', input)); }
  if (Object.keys(b).length) fail('invalid_request');
  return output(await dispatch(owner, match[2]!, input));
}
export default { async fetch(request, env) { try { return securityHeaders(await handle(request, env)); } catch (e) { return securityHeaders(errorResponse(e)); } } } satisfies ExportedHandler<ReceiverEnv>;
