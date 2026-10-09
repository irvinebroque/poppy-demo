import assert from 'node:assert/strict';
// Exercises only the synthetic account and exchange fixtures; never prints credentials.
const caller=process.env.POPPY_CALLER_ORIGIN??'https://poppy-caller.roundtrip.workers.dev';
const store=process.env.POPPY_RECEIVER_ORIGIN??'https://poppy-receiver.roundtrip.workers.dev';
const root=await fetch(caller);const visitor=root.headers.get('set-cookie').split(';')[0];
async function action(action){const r=await fetch(caller+'/api/action',{method:'POST',headers:{Cookie:visitor,Origin:caller,'Content-Type':'application/json'},body:JSON.stringify({action})});const body=await r.json();assert(r.ok,JSON.stringify(body));return body;}
await action('discover');let state=await action('start');const session=state.session_id;
state=await action('signin');const consent=await fetch(state.sign_in_url);const consentCookie=consent.headers.get('set-cookie').split(';')[0];const html=await consent.text();const nonce=html.match(/name="consent_nonce" value="([^"]+)"/)[1];
const approved=await fetch(store+'/oauth/authorize',{method:'POST',redirect:'manual',headers:{Cookie:consentCookie,Origin:store,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({consent_nonce:nonce,'poppy:read':'yes','poppy:write':'yes',decision:'approve'})});assert.equal(approved.status,303);
const callback=await fetch(approved.headers.get('location'),{redirect:'manual',headers:{Cookie:visitor}});assert.equal(callback.status,303,await callback.text());
state=await action('orders');assert.equal(state.signed_in,true);assert.equal(state.session_id,session);assert.equal(state.orders.orders[0].number,1042);
await action('propose');state=await action('exchange');assert.equal(state.exchange.exchange_id,'exc_demo_1042');
state=await action('new-session');assert.notEqual(state.session_id,session);assert.equal(state.signed_in,true);
state=await action('revoke');assert.equal(state.signed_in,false);assert.equal(state.account_connected,false);
console.log('Live HTTPS smoke passed: discovery, session, consent/PKCE callback, orders, simulated exchange, new session, revocation.');
