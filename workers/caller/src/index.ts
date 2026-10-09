import { cookie, randomSecret, bodyJson, json, fail, errorResponse, securityHeaders, escape } from '../../../shared/protocol';
import { AgentIdentity, CallerSession } from './session';
export { AgentIdentity, CallerSession };
async function handle(request: Request, env: CallerEnv) {
  const url = new URL(request.url);
  if (url.pathname === '/agent.json' && request.method === 'GET') return json({ client_id: env.CALLER_ORIGIN + '/agent.json', client_name: 'Poppy Personal Agent', jwks_uri: env.CALLER_ORIGIN + '/jwks.json', redirect_uris: [env.CALLER_ORIGIN + '/oauth/callback'], token_endpoint_auth_method: 'private_key_jwt' }, 200, { 'Cache-Control': 'public, max-age=300' });
  if (url.pathname === '/jwks.json' && request.method === 'GET') return json(await env.IDENTITY.getByName('signing-key').jwks(), 200, { 'Cache-Control': 'public, max-age=300' });
  if (url.pathname.startsWith('/assets/') && request.method === 'GET') return env.ASSETS.fetch(request);
  let visitor = cookie(request, 'poppy_visitor'); let fresh = false;
  if (!visitor || !/^[A-Za-z0-9_-]{43}$/.test(visitor)) { visitor = randomSecret(); fresh = true; }
  const agent = env.VISITORS.getByName(visitor);
  let response: Response;
  if (url.pathname === '/' && request.method === 'GET') { response = new Response((await env.ASSETS.fetch(request)).body, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }); }
  else if (url.pathname === '/oauth/callback' && request.method === 'GET') {
    if (fresh) fail('missing_oauth_session');
    const result = await agent.callbackRequest(Object.fromEntries(url.searchParams));
    if (result.error) return new Response(`<p>${escape(String(result.error))}. <a href="/">Return to your agent</a></p>`, { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    response = new Response(null, { status: 303, headers: { Location: '/', 'Cache-Control': 'no-store' } });
  } else if (url.pathname === '/api/state' && request.method === 'GET') response = json(await agent.view());
  else if (url.pathname === '/api/pi/view' && request.method === 'GET') response = await agent.piViewRequest();
  else if (url.pathname === '/api/agent/results' && request.method === 'GET') response = json({ jobs: await agent.results() });
  else if (['/api/action','/api/agent/prompt','/api/pi/abort','/api/pi/new'].includes(url.pathname) && request.method === 'POST') {
    if (fresh || request.headers.get('Origin') !== env.CALLER_ORIGIN || request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') fail('invalid_request');
    const b = await bodyJson(request);
    if (url.pathname === '/api/agent/prompt') { if (b.when_busy && !['followUp','steer'].includes(String(b.when_busy))) fail('invalid_request'); const r = await agent.submit(String(b.prompt ?? ''), String(b.operation_id ?? ''), b.when_busy === 'steer' ? 'steer' : 'followUp'); response = json(r,202); }
    else if (url.pathname === '/api/pi/abort') response = await agent.piAbortRequest();
    else if (url.pathname === '/api/pi/new') response = await agent.piNewRequest();
    else { response = await agent.actionRequest(String(b.action ?? ''), b); }
  } else fail('not_found',404);
  if (fresh) response.headers.set('Set-Cookie',`poppy_visitor=${visitor}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${env.LOCAL_DEMO === 'true' ? '' : '; Secure'}`);
  return response;
}
export default { async fetch(request, env) { try { return securityHeaders(await handle(request, env)); } catch (e) { return securityHeaders(errorResponse(e)); } } } satisfies ExportedHandler<CallerEnv>;
