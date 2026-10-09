import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

const company = 'https://store.test', caller = 'https://agent.test', client = caller + '/agent.json';
const grant = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
let mf, directory, agentKeys, dpopKeys, receiver;
const now = () => Math.floor(Date.now()/1000);
const random = () => crypto.randomUUID().replaceAll('-','');
const sha = async value => Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))).toString('base64url');
const signed = (claims, key, header = {}) => new SignJWT(claims).setProtectedHeader({alg:'ES256',typ:'JWT',kid:'agent-key-1',...header}).sign(key);
function assertion(sub, aud = company+'/oauth/token', extra = {}) { return signed({iss:client,sub,aud,iat:now(),exp:now()+60,jti:random(),...extra},agentKeys.privateKey); }
async function dpop(method,path,token,key=dpopKeys,extra={}) { const u=new URL(company+path);u.search='';return signed({htm:method,htu:u.href,iat:now(),jti:random(),...(token?{ath:await sha(token)}:{}),...extra},key.privateKey,{typ:'dpop+jwt',jwk:await exportJWK(key.publicKey),kid:undefined}); }
async function request(path,{method='GET',body,token,key,proof,headers={}}={}) {
 const h = {...headers};if(token){h.Authorization='DPoP '+token;h.DPoP=proof??await dpop(method,path,token,key)}
 if(body instanceof URLSearchParams){h['Content-Type']='application/x-www-form-urlencoded';body=body.toString()}else if(body!==undefined){h['Content-Type']='application/json';body=JSON.stringify(body)}
 return receiver.fetch(company+path,{method,body,headers:h,redirect:'manual'});
}
async function token(params,{proof,clientAssertion,sessionAssertion}={}) {
 const fields={client_id:client,client_assertion_type:'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',client_assertion:clientAssertion??await assertion(client),...params};
 if(fields.grant_type===grant) fields.assertion=sessionAssertion??await assertion(fields.user??'usr_test');delete fields.user;
 return request('/oauth/token',{method:'POST',body:new URLSearchParams(fields),headers:{DPoP:proof??await dpop('POST','/oauth/token')}});
}
async function start(user='usr_'+random()){const r=await token({grant_type:grant,user});assert.equal(r.status,200);return {user,...await r.json()};}
async function consent(session, scope='poppy:read poppy:write', decision='approve', options={}) {
 const verifier=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
 const params=new URLSearchParams({client_id:client,response_type:'code',redirect_uri:caller+'/oauth/callback',scope,state:'state_test',code_challenge:await sha(verifier),code_challenge_method:'S256'});
 const page=await request('/oauth/authorize?'+params);assert.equal(page.status,200);
 assert.equal(page.headers.get('Referrer-Policy'),'strict-origin');
 const html=await page.text();const nonce=html.match(/name="consent_nonce" value="([^"]+)"/)[1];
 const cookie=page.headers.get('Set-Cookie').split(';')[0];
 const approve=await request('/oauth/authorize',{method:'POST',body:new URLSearchParams({consent_nonce:nonce,decision,...Object.fromEntries(scope.split(' ').map(s=>[s,'yes']))}),headers:{Cookie:cookie,Origin:company}});
 if(approve.status!==303)assert.fail(await approve.text());const callback=new URL(approve.headers.get('Location'));assert.equal(callback.searchParams.get('iss'),company);assert.equal(callback.searchParams.get('state'),'state_test');
 if(decision!=='approve')return callback;
 const paramsToken={grant_type:'authorization_code',code:callback.searchParams.get('code'),code_verifier:verifier,redirect_uri:caller+'/oauth/callback',session_id:session.session_id};
 if(options.exchange===false)return paramsToken;
 const exchange=await token(paramsToken);assert.equal(exchange.status,200);return {...await exchange.json(),paramsToken};
}
before(async()=>{
 directory=await mkdtemp(join(tmpdir(),'poppy-tests-'));agentKeys=await generateKeyPair('ES256',{extractable:true});dpopKeys=await generateKeyPair('ES256',{extractable:true});
 const publicKey={...await exportJWK(agentKeys.publicKey),kid:'agent-key-1',use:'sig',alg:'ES256'};
 await build({entryPoints:['workers/receiver/src/index.ts'],bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers'],outfile:join(directory,'receiver.mjs')});
 const manifest = contents => ({mainModule:'index.mjs',modules:{'index.mjs':{type:'esm',contents}}});
 mf=new Miniflare({upstream:company,unsafeLocalExplorer:false,workers:[{config:{name:'receiver',domains:['store.test'],compatibilityDate:'2026-10-09',compatibilityFlags:['nodejs_compat'],manifest:manifest(await readFile(join(directory,'receiver.mjs'),'utf8')),exports:{CompanyUser:{type:'durable-object',storage:'sqlite'},ReplayGuard:{type:'durable-object',storage:'sqlite'}},env:{OWNERS:{type:'durable-object',worker:'receiver',exportName:'CompanyUser'},GUARDS:{type:'durable-object',worker:'receiver',exportName:'ReplayGuard'},CALLER_ORIGIN:{type:'json',value:caller},RECEIVER_ORIGIN:{type:'json',value:company},LOCAL_DEMO:{type:'json',value:'false'},CALLER:{type:'worker',worker:'metadata'}}}},{config:{name:'metadata',compatibilityDate:'2026-10-09',manifest:manifest(`export default {fetch(request){return Response.json(new URL(request.url).pathname==='/jwks.json'?{keys:[${JSON.stringify(publicKey)}]}:{client_id:'${client}',client_name:'Test Agent',jwks_uri:'${caller}/jwks.json',redirect_uris:['${caller}/oauth/callback'],token_endpoint_auth_method:'private_key_jwt'})}}`)}}]});
 receiver=await mf.getWorker('receiver');
});
after(async()=>{await mf?.dispose();await rm(directory,{recursive:true,force:true})});

test('reciprocal discovery, client metadata and OpenAPI',async()=>{
 const d=await (await request('/.well-known/poppy.json')).json(),m=await (await request('/.well-known/oauth-authorization-server')).json();
 assert.equal(d.protocol_version,'0.1');assert.equal(d.auth.issuer,m.issuer);assert.ok(m.poppy_domains.includes(d.organization.domain));assert.equal(d.auth.device,undefined);assert.equal(d.web.browser_session_endpoint,undefined);
 const api=await (await request('/openapi.json')).json();assert.equal(api.openapi,'3.1.0');assert.ok(api.paths['/api/orders']);
});
test('signed-out sessions use two assertions and bound DPoP tokens',async()=>{
 const s=await start();assert.equal(s.signed_in,false);assert.equal(s.token_type,'DPoP');assert.equal(s.scope,'');
 const r=await request('/api/orders',{token:s.access_token});assert.equal(r.status,403);assert.match(r.headers.get('WWW-Authenticate'),/sign_in_required/);
 const renew=await token({grant_type:grant,user:s.user,session_id:s.session_id});assert.equal(renew.status,200);assert.equal((await renew.json()).session_id,s.session_id);
 const wrong=await token({grant_type:grant,user:'usr_different',session_id:s.session_id});assert.equal(wrong.status,400);assert.equal((await wrong.json()).error,'invalid_session');
});
test('assertion and DPoP replays, wrong method, wrong key and token hash fail',async()=>{
 const clientAssertion=await assertion(client),sessionAssertion=await assertion('usr_replay');
 const r=await token({grant_type:grant},{clientAssertion,sessionAssertion});assert.equal(r.status,200);const s=await r.json();
 assert.equal((await token({grant_type:grant},{clientAssertion,sessionAssertion})).status,401);
 const replaySession=await token({grant_type:grant},{sessionAssertion});assert.equal((await replaySession.json()).error,'invalid_grant');
 const p=await dpop('GET','/api/orders',s.access_token);assert.equal((await request('/api/orders',{token:s.access_token,proof:p})).status,403);
 const replay=await request('/api/orders',{token:s.access_token,proof:p});assert.equal((await replay.json()).error,'invalid_dpop_proof');
 const badMethod=await request('/api/orders',{token:s.access_token,proof:await dpop('POST','/api/orders',s.access_token)});assert.equal(badMethod.status,401);
 const otherKey=await generateKeyPair('ES256',{extractable:true});assert.equal((await request('/api/orders',{token:s.access_token,key:otherKey})).status,401);
 const badHash=await request('/api/orders',{token:s.access_token,proof:await dpop('GET','/api/orders','wrong-token')});assert.equal(badHash.status,401);
 assert.equal((await request('/api/orders',{headers:{Authorization:'Bearer '+s.access_token}})).status,401);
});
test('consent decline, PKCE, one-time codes, scoped access, refresh and immediate revocation',async()=>{
 const s=await start();const declined=await consent(s,'poppy:read','deny');assert.equal(declined.searchParams.get('error'),'access_denied');
 const signed=await consent(s,'poppy:read');assert.equal(signed.signed_in,true);assert.ok(signed.refresh_token);
 assert.equal((await token(signed.paramsToken)).status,400);
 assert.equal((await request('/api/orders',{token:signed.access_token})).status,200);
 const exchange=await request('/api/orders/ord_1042/exchanges',{method:'POST',token:signed.access_token,body:{replacement_sku:'stormline-insulated-m'}});assert.equal(exchange.status,403);assert.equal((await exchange.json()).error,'insufficient_scope');
 const refreshed=await token({grant_type:'refresh_token',refresh_token:signed.refresh_token});assert.equal(refreshed.status,200);const next=await refreshed.json();assert.notEqual(next.session_id,s.session_id);
 const narrow=await token({grant_type:'refresh_token',refresh_token:signed.refresh_token,scope:'poppy:write'});assert.equal(narrow.status,400);
 const revoke=await request('/oauth/revoke',{method:'POST',body:new URLSearchParams({token:signed.refresh_token,client_id:client,client_assertion_type:'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',client_assertion:await assertion(client,company+'/oauth/revoke')})});assert.equal(revoke.status,200);
 for(const t of [signed.access_token,next.access_token]){const r=await request('/api/orders',{token:t});assert.equal(r.status,403);assert.equal((await r.json()).error,'sign_in_required')}
 const invalid=await token({grant_type:'refresh_token',refresh_token:signed.refresh_token});assert.equal(invalid.status,400);assert.equal((await invalid.json()).error,'invalid_grant');
});
test('conversations: retry first message, conflicts, authorization, cursor, ownership, direct and close',async()=>{
 const s=await start();const message={id:'msg_'+random(),sender:'agent',text:'Help exchange order #1042'};
 const create=await request('/poppy/conversations?wait=1',{method:'POST',token:s.access_token,body:{message}});assert.equal(create.status,201);const c=await create.json();assert.ok(c.events.some(e=>e.type==='authorization'));assert.equal(c.status,'idle');
 const retry=await request('/poppy/conversations?wait=1',{method:'POST',token:s.access_token,body:{message}});assert.deepEqual(await retry.json(),c);
 const conflict=await request('/poppy/conversations',{method:'POST',token:s.access_token,body:{message:{...message,text:'Different'}}});assert.equal(conflict.status,409);assert.equal((await conflict.json()).error,'message_id_conflict');
 const events=await request('/poppy/conversations/'+c.conversation_id+'/events?cursor='+c.cursor,{token:s.access_token});const tail=await events.json();assert.deepEqual(tail.events,[]);assert.equal(tail.cursor,c.cursor);assert.equal(tail.has_more,false);
 const badCursor=await request('/poppy/conversations/'+c.conversation_id+'/events?cursor=not_yours',{token:s.access_token});assert.equal((await badCursor.json()).error,'invalid_cursor');
 const stranger=await start();const forbidden=await request('/poppy/conversations/'+c.conversation_id+'/events',{token:stranger.access_token});assert.equal(forbidden.status,404);
 const direct=await request('/poppy/conversations?wait=1',{method:'POST',token:s.access_token,body:{parent_conversation_id:c.conversation_id,message:{id:'msg_'+random(),sender:'human',text:'I have a question.'}}});assert.equal(direct.status,201);const child=await direct.json();
 const blocked=await request('/poppy/conversations/'+c.conversation_id+'/messages',{method:'POST',token:s.access_token,body:{message:{id:'msg_'+random(),sender:'agent',text:'One more question'}}});assert.equal((await blocked.json()).error,'direct_conversation_open');
 const closing=await request('/poppy/conversations/'+c.conversation_id+'/close',{method:'POST',token:s.access_token,body:{}});assert.equal(closing.status,200);
 const childEvents=await request('/poppy/conversations/'+child.conversation_id+'/events',{token:s.access_token});assert.equal((await childEvents.json()).status,'closed');
 const closed=await request('/poppy/conversations/'+c.conversation_id+'/messages',{method:'POST',token:s.access_token,body:{message:{id:'msg_'+random(),sender:'human',text:'Hello'}}});assert.equal((await closed.json()).error,'conversation_closed');
});
test('account-pinned conversation requires sign-in again; exchange is repeatable without duplicate side effects',async()=>{
 const s=await start();const signed=await consent(s);
 const message={id:'msg_'+random(),sender:'agent',text:'Look up my order'};
 const created=await request('/poppy/conversations?wait=1',{method:'POST',token:signed.access_token,body:{message}});const c=await created.json();
 const signedOut=await request('/poppy/conversations/'+c.conversation_id+'/events',{token:s.access_token});assert.equal((await signedOut.json()).error,'sign_in_required');
 for(let i=0;i<2;i++){const exchange=await request('/api/orders/ord_1042/exchanges',{method:'POST',token:signed.access_token,body:{replacement_sku:'stormline-insulated-m'}});assert.equal(exchange.status,201);assert.equal((await exchange.json()).exchange_id,'exc_demo_1042')}
});

test('wrong PKCE verifier cannot redeem an authorization code',async()=>{
 const session=await start();
 const params=await consent(session,'poppy:read','approve',{exchange:false});
 const wrong=await token({...params,code_verifier:'a'.repeat(43)});
 assert.equal(wrong.status,400);assert.equal((await wrong.json()).error,'invalid_grant');
 assert.equal((await token(params)).status,400);
});
