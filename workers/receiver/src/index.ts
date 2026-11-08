import type { JWK } from 'jose';
import { PROTOCOL_VERSION, validId, verifySession, CLIENT_ASSERTION, SCOPES, fail, json, errorResponse, hash, randomSecret, now, scopes, verifyAssertion, verifyProof, permittedUrl, formBody, bodyJson, readText, cookie, securityHeaders, type Message, type RpcResult } from '../../../shared/protocol';
import { CompanyUser, ReplayGuard, type Input } from './state';
import { storePage, consentPage, productPage } from './ui';
export { CompanyUser, ReplayGuard };

type Client = { client_id: string; client_name: string; jwks_uri: string; redirect_uris: string[]; token_endpoint_auth_method: string };
const clientId = (env: ReceiverEnv) => env.CALLER_ORIGIN + '/agent.json';
function guard(env: ReceiverEnv, key: string) { return env.GUARDS.getByName(key); }
async function client(env: ReceiverEnv, value: string): Promise<{ metadata: Client; keys: JWK[] }> {
  // This demo is explicitly registered to one peer; never fetch arbitrary client-provided URLs.
  if (value !== clientId(env)) fail('invalid_client', 401);
  const response = await env.CALLER.fetch(value, { redirect: 'manual' });
  if (!response.ok) fail('invalid_client', 401);
  const metadata = JSON.parse(await readText(response)) as Client;
  if (metadata.client_id !== value || metadata.jwks_uri !== env.CALLER_ORIGIN + '/jwks.json' || metadata.token_endpoint_auth_method !== 'private_key_jwt' || !Array.isArray(metadata.redirect_uris)) fail('invalid_client', 401);
  const origin = permittedUrl(value, env.LOCAL_DEMO === 'true').origin;
  if (metadata.redirect_uris.some(uri => permittedUrl(uri, env.LOCAL_DEMO === 'true').origin !== origin)) fail('invalid_client', 401);
  const keyResponse = await env.CALLER.fetch(metadata.jwks_uri, { redirect: 'manual' });
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
  if (!await guard(env, 'dpop:' + p.thumbprint).accept(p.jti, p.replayExpiresAt)) fail('invalid_dpop_proof', token ? 401 : 400);
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
  const p = await formBody(request);
  const auth = await authenticateClient(env, p, env.RECEIVER_ORIGIN); const jkt = await checkProof(env, request);
  const grantType = p.get('grant_type');
  // OAuth is independent of Poppy User IDs and Sessions.
  const owner = env.OWNERS.getByName('oauth:' + auth.value);
  let action: string; let grant: string; let replacement: string | undefined; let grantedScope: string[] | undefined;
  if (grantType === 'authorization_code') {
    const code = await guard(env, 'codes:' + auth.value).takeCode(await hash(p.get('code') ?? ''));
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(p.get('code_verifier') ?? '')) fail('invalid_grant');
    if (!code || Number(code.expires) < now() || code.redirect !== p.get('redirect_uri') || code.challenge !== await hash(p.get('code_verifier') ?? '')) fail('invalid_grant');
    action = 'sign-in'; replacement = owner.id.toString() + '.' + randomSecret(); grant = await hash(replacement); grantedScope = code.scope;
  } else if (grantType === 'refresh_token') {
    const token = p.get('refresh_token') ?? '';
    // Only the authenticated client's credential store can redeem this token.
    if (token.split('.')[0] !== owner.id.toString()) fail('invalid_grant');
    grant = await hash(token); action = 'refresh';
  } else fail('unsupported_grant_type');
  const resource = p.get('resource') ?? undefined;
  if (resource && ![env.RECEIVER_ORIGIN, env.RECEIVER_ORIGIN + '/poppy/conversations'].includes(resource)) fail('invalid_target');
  const token = owner.id.toString() + '.' + randomSecret();
  const result = await dispatch(owner, action, { client: auth.value, jkt, token, secret: await hash(token), grant, replacement, scope: p.has('scope') ? scopes(p.get('scope'), grantedScope ?? SCOPES) : grantedScope, resource });
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
    if (!scope.length) redirect.searchParams.set('error', 'access_denied');
    else {
      // Identity is a clearly labeled synthetic account; replace this step with real login in production.
      await guard(env, 'codes:' + details.client).saveCode(await hash(code), { ...details, scope, expires: now() + 60 });
      redirect.searchParams.set('code', code);
    }
  } else redirect.searchParams.set('error', 'access_denied');
  return new Response(null, { status: 303, headers: { Location: redirect.href, 'Cache-Control': 'no-store', 'Set-Cookie': `poppy_consent=; Max-Age=0; Path=/oauth/authorize; HttpOnly; SameSite=Lax${env.LOCAL_DEMO === 'true' ? '' : '; Secure'}` } });
}
function message(value: unknown): Message {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_request');
  const m = value as Message;
  if (!m.author || !['agent','human'].includes(m.author.type) || !['text','data','context','extensions'].some(k => k in m) || (m.text !== undefined && typeof m.text !== 'string') || [m.data,m.context,m.extensions].some(v => v !== undefined && (!v || typeof v !== 'object' || Array.isArray(v)))) fail('invalid_request');
  if (m.context && ((m.context.locale !== undefined && typeof m.context.locale !== 'string') || (m.context.time_zone !== undefined && typeof m.context.time_zone !== 'string') || (m.context.user_available !== undefined && typeof m.context.user_available !== 'boolean'))) fail('invalid_request');
  if (m.extensions && Object.values(m.extensions).some(v => !v || typeof v !== 'object' || Array.isArray(v))) fail('invalid_request');
  if (m.as_of_cursor !== undefined && (m.author.type === 'human' || !validId(m.as_of_cursor))) fail('invalid_request');
  // Unrecognized extensions/fields are ignored. No extensions are advertised by this demo.
  return { author: { type: m.author.type }, ...(m.text !== undefined ? { text: m.text } : {}), ...(m.data ? { data: m.data } : {}), ...(m.context ? { context: m.context } : {}), ...(m.extensions ? { extensions: m.extensions } : {}), ...(m.as_of_cursor ? { as_of_cursor: m.as_of_cursor } : {}) };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
async function handle(request: Request, env: ReceiverEnv): Promise<Response> {
  const url = new URL(request.url); const path = url.pathname; const origin = env.RECEIVER_ORIGIN;
  permittedUrl(origin, env.LOCAL_DEMO === 'true');
  if (path === '/' && request.method === 'GET') return new Response(storePage(env.CALLER_ORIGIN), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  if (path.startsWith('/products/') && request.method === 'GET') { const html = productPage(path.slice('/products/'.length), env.CALLER_ORIGIN); if (!html) fail('not_found',404); return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }); }
  if (path === '/.well-known/poppy.json' && request.method === 'GET') return json({ protocol_version: PROTOCOL_VERSION, organization: { name: 'Northstar Outfitters', domain: new URL(origin).hostname }, auth: { scopes: { 'orders:read': 'Read your orders', 'orders:write': 'Arrange a simulated jacket exchange' }, scope_hints: { 'orders:read': { changes: 'none', personal_data: true }, 'orders:write': { changes: 'irreversible', personal_data: true } } }, agent: { protocols: [{ type: 'poppy', endpoint: origin + '/poppy/conversations' }] }, apis: [{ type: 'openapi', url: origin + '/openapi.json', description: 'Orders and jacket exchanges' }], web: {} }, 200, { 'Cache-Control': 'public, max-age=300' });
  if (path === '/.well-known/oauth-protected-resource' && request.method === 'GET') return json({ resource: origin, authorization_servers: [origin] }, 200, { 'Cache-Control': 'public, max-age=300' });
  if (path === '/.well-known/oauth-protected-resource/poppy/conversations' && request.method === 'GET') return json({ resource: origin + '/poppy/conversations', authorization_servers: [origin] });
  if (path === '/.well-known/oauth-authorization-server' && request.method === 'GET') return json({ issuer: origin, protected_resources: [origin, origin + '/poppy/conversations'], authorization_endpoint: origin + '/oauth/authorize', token_endpoint: origin + '/oauth/token', revocation_endpoint: origin + '/oauth/revoke', grant_types_supported: ['authorization_code', 'refresh_token'], response_types_supported: ['code'], token_endpoint_auth_methods_supported: ['private_key_jwt'], token_endpoint_auth_signing_alg_values_supported: ['ES256'], code_challenge_methods_supported: ['S256'], dpop_signing_alg_values_supported: ['ES256'], scopes_supported: SCOPES }, 200, { 'Cache-Control': 'public, max-age=300' });
  if (path === '/openapi.json' && request.method === 'GET') return json({ openapi: '3.1.0', info: { title: 'Northstar demo API', version: '0.4.0' }, servers: [{ url: origin }], security: [{ DPoP: [] }], components: { securitySchemes: { DPoP: { type: 'http', scheme: 'DPoP', description: 'OAuth access token with a DPoP proof (RFC 9449); also requires Poppy-Session and Poppy-Version headers' } } }, paths: { '/api/orders': { get: { operationId: 'listOrders', summary: 'List orders; requires orders:read', responses: { '200': { description: 'Orders' }, '400': { description: 'Invalid Session or unsupported Poppy version' }, '401': { description: 'Sign in or refresh account access' }, '403': { description: 'Approve orders:read' } } } }, '/api/orders/ord_1042/exchanges': { post: { operationId: 'exchangeJacket', summary: 'Exchange a jacket; requires orders:write', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['replacement_sku'], properties: { replacement_sku: { type: 'string', enum: ['stormline-insulated-m'] } } } } } }, responses: { '201': { description: 'Exchange confirmed' }, '400': { description: 'Invalid Session or unsupported Poppy version' }, '401': { description: 'Sign in or refresh account access' }, '403': { description: 'Approve orders:write' } } } } } });
  if (path === '/oauth/authorize') return authorize(request, env);
  if (path === '/oauth/token' && request.method === 'POST') return tokenEndpoint(request, env);
  if (path === '/oauth/revoke' && request.method === 'POST') {
    const p = await formBody(request); const auth = await authenticateClient(env, p, origin);
    const token = p.get('token') ?? '';
    try { const owner = ownerFromToken(env, token); await dispatch(owner, 'revoke', { client: auth.value, grant: await hash(token) }); } catch { /* RFC 7009: unknown tokens return success. */ }
    return json({});
  }
  if (!path.startsWith('/api/') && !path.startsWith('/poppy/conversations')) fail('not_found', 404);
  if (['access_token', 'poppy_session'].some(key => url.searchParams.has(key))) fail('invalid_request');
  if (request.headers.get('Poppy-Version') !== PROTOCOL_VERSION) fail('version_unsupported');
  const header = request.headers.get('Authorization');
  if (header && !header.startsWith('DPoP ')) fail('invalid_token', 401);
  const token = header?.slice(5);
  let keys: JWK[];
  try { keys = (await client(env, clientId(env))).keys; } catch { fail('invalid_session'); }
  const session = await verifySession(request, keys, clientId(env), origin, token);
  if (!await guard(env, 'sessions:' + clientId(env)).accept(session.jti, session.replayExpiresAt)) fail('invalid_session');
  const input: Input = { client: clientId(env), user: session.user, session: session.session, agent: session.agent, resource: path.startsWith('/api/') ? origin : origin + '/poppy/conversations' };
  if (header) {
    if (!token) fail('invalid_token', 401);
    const jkt = await checkProof(env, request, token);
    const result = await dispatch(ownerFromToken(env, token), 'authenticate-token', { client: clientId(env), secret: await hash(token), jkt, resource: input.resource });
    if (result.body.error) return output(result);
    input.account = String(result.body.account); input.scope = result.body.scope as string[];
  }
  const owner = env.OWNERS.getByName(clientId(env) + ':' + session.user);
  if (path === '/api/orders' && request.method === 'GET') return output(await dispatch(owner, 'orders', input));
  if (path === '/api/orders/ord_1042/exchanges' && request.method === 'POST') { const b = await bodyJson(request); input.replacement = String(b.replacement_sku ?? ''); return output(await dispatch(owner, 'exchange', input)); }
  const match = path.match(/^\/poppy\/conversations(?:\/([A-Za-z0-9_-]{1,256})\/(messages|events|handoff(?:\/cancel)?|close))?$/);
  if (!match) fail('not_found', 404);
  input.conversation = match[1]; input.cursor = url.searchParams.get('cursor') ?? undefined;
  if (url.searchParams.has('wait') && !/^\d+$/.test(url.searchParams.get('wait')!)) fail('invalid_request');
  input.wait = url.searchParams.has('wait');
  if (match[2] === 'events' && request.method === 'GET') return output(await dispatch(owner, 'events', input));
  if (request.method !== 'POST') fail('method_not_allowed', 405);
  const b = await bodyJson(request);
  if (!validId(b.id)) fail('invalid_request');
  input.requestId = b.id; input.requestContent = path + ':' + canonical(b);
  if (!match[1] || match[2] === 'messages') {
    if (b.message !== undefined) input.message = message(b.message);
    if (!match[1]) {
      if (b.parent_conversation_id !== undefined && !validId(b.parent_conversation_id)) fail('invalid_request');
      if (b.user_requested_event_id !== undefined && (!validId(b.user_requested_event_id) || !b.parent_conversation_id)) fail('invalid_request');
      input.parent = b.parent_conversation_id as string | undefined; input.invitation = b.user_requested_event_id as string | undefined;
    }
    if (!input.message && !input.invitation) fail('invalid_request');
    return output(await dispatch(owner, match[1] ? 'message' : 'create', input));
  }
  return output(await dispatch(owner, match[2]!, input));
}
export default { async fetch(request, env) { try { return securityHeaders(await handle(request, env)); } catch (e) { return securityHeaders(errorResponse(e)); } } } satisfies ExportedHandler<ReceiverEnv>;
