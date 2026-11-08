import { test, beforeAll, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import { buildWorker } from "./build-worker.mjs";
import { guacAvailable } from "../scripts/prepare-guac.mjs";
import { Miniflare } from "miniflare";
import { generateKeyPair, exportJWK, SignJWT, calculateJwkThumbprint } from "jose";

const company = "https://store.test",
  caller = "https://agent.test",
  client = caller + "/agent.json";

let mf, agentKeys, dpopKeys, delegatedKeys, delegation, receiver;
const now = () => Math.floor(Date.now() / 1000);
const random = () => crypto.randomUUID().replaceAll("-", "");

const sha = async (value) =>
  Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString(
    "base64url",
  );

const signed = (claims, key, header = {}) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: "agent-key-1", ...header })
    .sign(key);

function assertion(aud = company, extra = {}) {
  return signed(
    { iss: client, sub: client, aud, iat: now(), exp: now() + 60, jti: random(), ...extra },
    agentKeys.privateKey,
  );
}

async function delegate(key = delegatedKeys, extra = {}, header = {}) {
  return signed(
    {
      iss: client,
      cnf: { jwk: await exportJWK(key.publicKey) },
      iat: now(),
      exp: now() + 3600,
      jti: random(),
      ...extra,
    },
    agentKeys.privateKey,
    { typ: "poppy-delegation+jwt", ...header },
  );
}

async function sessionProof(s, method, path, token, extra = {}, header = {}, key = delegatedKeys) {
  const url = new URL(company + path);
  url.search = "";

  return signed(
    {
      iss: client,
      aud: company,
      sid: s.session_id,
      sub: s.user,
      htm: method,
      htu: url.href,
      iat: now(),
      jti: random(),
      ath: token ? await sha(token) : undefined,
      ...extra,
    },
    key.privateKey,
    {
      typ: "poppy-session+jwt",
      kid: await calculateJwkThumbprint(await exportJWK(key.publicKey)),
      poppy_dlg: delegation,
      ...header,
    },
  );
}

async function dpop(method, path, token, key = dpopKeys, extra = {}) {
  const url = new URL(company + path);
  url.search = "";

  return signed(
    {
      htm: method,
      htu: url.href,
      iat: now(),
      jti: random(),
      ath: token ? await sha(token) : undefined,
      ...extra,
    },
    key.privateKey,
    { typ: "dpop+jwt", jwk: await exportJWK(key.publicKey), kid: undefined },
  );
}

async function request(
  path,
  {
    method = "GET",
    body,
    session,
    token = path.startsWith("/poppy/conversations")
      ? (session?.conversation_access_token ?? session?.access_token)
      : session?.access_token,
    key,
    proof,
    sessionJwt,
    headers = {},
  } = {},
) {
  const h = { ...headers };

  if (session) {
    h["Poppy-Session"] = sessionJwt ?? (await sessionProof(session, method, path, token));
    h["Poppy-Version"] = "0.4";
  }

  if (token) {
    h.Authorization = "DPoP " + token;
    h.DPoP = proof ?? (await dpop(method, path, token, key));
  }

  Object.assign(h, headers);

  for (const k of Object.keys(h)) if (h[k] === null) delete h[k];

  if (body instanceof URLSearchParams) {
    h["Content-Type"] = "application/x-www-form-urlencoded";
    body = body.toString();
  } else if (body !== undefined) {
    h["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }

  return receiver.fetch(company + path, { method, body, headers: h, redirect: "manual" });
}

async function token(params, { proof, clientAssertion } = {}) {
  const fields = {
    client_id: client,
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: clientAssertion ?? (await assertion()),
    ...params,
  };

  return request("/oauth/token", {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: { DPoP: proof ?? (await dpop("POST", "/oauth/token")) },
  });
}

const start = (user = "usr_" + random()) => ({ user, session_id: "ses_" + random() });

async function consent(s, scope = "orders:read orders:write", decision = "approve", options = {}) {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

  const params = new URLSearchParams({
    client_id: client,
    response_type: "code",
    redirect_uri: caller + "/oauth/callback",
    scope,
    state: "state_test",
    code_challenge: await sha(verifier),
    code_challenge_method: "S256",
  });

  const page = await request("/oauth/authorize?" + params);
  assert.equal(page.status, 200, await page.clone().text());
  assert.equal(page.headers.get("Referrer-Policy"), "strict-origin");
  const nonce = (await page.text()).match(/name="consent_nonce" value="([^"]+)"/)[1];
  const cookie = page.headers.get("Set-Cookie").split(";")[0];

  const approve = await request("/oauth/authorize", {
    method: "POST",
    body: new URLSearchParams({
      consent_nonce: nonce,
      decision,
      ...Object.fromEntries((options.selected ?? scope.split(" ")).map((s) => [s, "yes"])),
    }),
    headers: { Cookie: cookie, Origin: company },
  });

  assert.equal(approve.status, 303, await approve.clone().text());
  const callback = new URL(approve.headers.get("Location"));
  assert.equal(callback.searchParams.get("iss"), company);
  assert.equal(callback.searchParams.get("state"), "state_test");

  if (decision !== "approve" || options.selected?.length === 0) return callback;

  const paramsToken = {
    grant_type: "authorization_code",
    code: callback.searchParams.get("code"),
    code_verifier: verifier,
    redirect_uri: caller + "/oauth/callback",
  };

  if (options.exchange === false) return paramsToken;
  const exchange = await token(paramsToken);
  assert.equal(exchange.status, 200, await exchange.clone().text());
  const approved = { ...s, ...(await exchange.json()), paramsToken };

  const conversation = await token({
    grant_type: "refresh_token",
    refresh_token: approved.refresh_token,
    resource: company + "/poppy/conversations",
  });

  assert.equal(conversation.status, 200);
  approved.conversation_access_token = (await conversation.json()).access_token;

  return approved;
}

const message = (text = "Tell me about jackets", author = "agent") => ({
  id: "req_" + random(),
  message: { author: { type: author }, text },
});

const create = async (s, body = message(), query = "?wait=0") => {
  const r = await request("/poppy/conversations" + query, { method: "POST", session: s, body });
  assert.equal(r.status, 201, await r.clone().text());

  return r.json();
};

const post = (s, c, action, body = { id: "req_" + random() }) =>
  request(`/poppy/conversations/${c.conversation_id}/${action}`, {
    method: "POST",
    session: s,
    body,
  });

const events = (s, c, query = "") =>
  request(`/poppy/conversations/${c.conversation_id}/events${query}`, { session: s });

async function error(r, status, code) {
  assert.equal(r.status, status, await r.clone().text());
  assert.equal((await r.json()).error, code);
}

beforeAll(async () => {
  agentKeys = await generateKeyPair("ES256", { extractable: true });
  dpopKeys = await generateKeyPair("ES256", { extractable: true });
  delegatedKeys = await generateKeyPair("ES256", { extractable: true });
  delegation = await delegate();

  const publicKey = {
    ...(await exportJWK(agentKeys.publicKey)),
    kid: "agent-key-1",
    use: "sig",
    alg: "ES256",
  };

  const source = await buildWorker("receiver");

  const manifest = (contents) => ({
    mainModule: "index.mjs",
    modules: { "index.mjs": { type: "esm", contents } },
  });

  mf = new Miniflare({
    upstream: company,
    unsafeLocalExplorer: false,
    workers: [
      {
        config: {
          name: "receiver",
          domains: ["store.test"],
          compatibilityDate: "2026-10-09",
          compatibilityFlags: ["nodejs_compat"],
          manifest: source,
          exports: {
            CompanyUser: { type: "durable-object", storage: "sqlite" },
            ReplayGuard: { type: "durable-object", storage: "sqlite" },
          },
          env: {
            OWNERS: { type: "durable-object", worker: "receiver", exportName: "CompanyUser" },
            GUARDS: { type: "durable-object", worker: "receiver", exportName: "ReplayGuard" },
            CALLER_ORIGIN: { type: "json", value: caller },
            RECEIVER_ORIGIN: { type: "json", value: company },
            LOCAL_DEMO: { type: "json", value: "false" },
            CALLER: { type: "worker", worker: "metadata" },
          },
        },
      },
      {
        config: {
          name: "metadata",
          compatibilityDate: "2026-10-09",
          manifest: manifest(
            `export default {fetch(request){return Response.json(new URL(request.url).pathname==='/jwks.json'?{keys:[${JSON.stringify(publicKey)}]}:{client_id:'${client}',client_name:'Test Agent',jwks_uri:'${caller}/jwks.json',redirect_uris:['${caller}/oauth/callback'],token_endpoint_auth_method:'private_key_jwt'})}}`,
          ),
        },
      },
    ],
  });
  receiver = await mf.getWorker("receiver");
});

afterAll(async () => {
  await mf?.dispose();
});

test("0.4 discovery uses described company scopes and reciprocal RFC 9728 resources", async () => {
  const d = await (await request("/.well-known/poppy.json")).json(),
    m = await (await request("/.well-known/oauth-authorization-server")).json();

  const resource = await (await request("/.well-known/oauth-protected-resource")).json();
  assert.equal(d.protocol_version, "0.4");
  assert.equal(resource.resource, company);
  assert.deepEqual(resource.authorization_servers, [m.issuer]);
  assert.ok(m.protected_resources.includes(company));
  assert.equal(m.poppy_domains, undefined);
  assert.equal(d.auth.direct, undefined);
  assert.equal(d.auth.scopes["orders:read"], "Read your orders");
  assert.deepEqual(m.grant_types_supported, ["authorization_code", "refresh_token"]);
  const api = await (await request("/openapi.json")).json();
  assert.equal(api.openapi, "3.1.0");
  assert.ok(api.paths["/api/orders"]);
  assert.equal(d.web.browser_session_endpoint, undefined);

  if (await guacAvailable())
    assert.deepEqual(d.extensions, {
      mole: [{ version: "1", moderator_config_uri: company + "/mole/moderator/config" }],
    });
  else assert.equal(d.extensions, undefined);
});

test("signed-out requests need only a delegated Session JWT; no token grant", async () => {
  const s = start();
  const c = await create(s);
  assert.equal(c.working, false);
  assert.equal(c.handoff, "none");
  assert.equal(c.closed, false);
  assert.equal(c.responder, "agent");
  assert.equal(c.status, undefined);
  const r = await request("/api/orders", { session: s });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get("WWW-Authenticate"), 'DPoP scope="orders:read"');
  assert.deepEqual(await r.json(), {});
  await error(
    await token({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer" }),
    400,
    "unsupported_grant_type",
  );
  await error(await events(start(), c), 404, "conversation_not_found");
  await error(await events(start("different_user"), c), 404, "conversation_not_found");
  assert.equal((await events({ ...s, session_id: random() }, c)).status, 200);
});

test("Session verification rejects missing version/header, wrong audience/method/URL/hash, stale/replayed JWTs and spoofed issuers", async () => {
  const s = start();
  const path = "/poppy/conversations";
  const body = message();
  await error(await request(path, { method: "POST", body }), 400, "version_unsupported");
  await error(
    await request(path, { method: "POST", body, headers: { "Poppy-Version": "0.4" } }),
    400,
    "invalid_session",
  );

  for (const version of [null, "0.1", "0.3", "0.5", "0.4.0"])
    await error(
      await request(path, {
        method: "POST",
        body,
        session: s,
        headers: { "Poppy-Version": version },
      }),
      400,
      "version_unsupported",
    );

  for (const extra of [
    { aud: company + "/oauth/token" },
    { aud: [company] },
    { htm: "GET" },
    { htu: company + "/wrong" },
    { iat: now() - 90 },
    { iat: now() + 90 },
    { iss: "https://evil.test/agent.json" },
    { sub: "" },
    { sid: "bad/id" },
    { ath: await sha("absent-token") },
  ]) {
    await error(
      await request(path, {
        method: "POST",
        body,
        session: s,
        sessionJwt: await sessionProof(s, "POST", path, undefined, extra),
      }),
      400,
      "invalid_session",
    );
  }

  const jwt = await sessionProof(s, "POST", path);
  assert.equal(
    (await request(path, { method: "POST", body, session: s, sessionJwt: jwt })).status,
    201,
  );
  await error(
    await request(path, { method: "POST", body, session: s, sessionJwt: jwt }),
    400,
    "invalid_session",
  );
});

test("delegations enforce trust chain, expiry, lifetime, type, public key and thumbprint; keys can rotate", async () => {
  const s = start();
  const path = "/poppy/conversations";

  const invalidDelegations = [
    await delegate(delegatedKeys, { exp: now() - 1 }),
    await delegate(delegatedKeys, { exp: now() + 86401 }),
    await delegate(delegatedKeys, { iss: "https://evil.test/agent.json" }),
    await delegate(delegatedKeys, { cnf: { jwk: await exportJWK(delegatedKeys.privateKey) } }),
    await delegate(delegatedKeys, {}, { typ: "JWT" }),
    await delegate(delegatedKeys, {}, { kid: "untrusted" }),
  ];

  for (const dlg of invalidDelegations)
    await error(
      await request(path, {
        method: "POST",
        body: message(),
        session: s,
        sessionJwt: await sessionProof(s, "POST", path, undefined, {}, { poppy_dlg: dlg }),
      }),
      400,
      "invalid_session",
    );

  for (const header of [{ poppy_dlg: undefined }, { kid: "wrong" }, { typ: "JWT" }])
    await error(
      await request(path, {
        method: "POST",
        body: message(),
        session: s,
        sessionJwt: await sessionProof(s, "POST", path, undefined, {}, header),
      }),
      400,
      "invalid_session",
    );
  const c = await create(s);
  const rotated = await generateKeyPair("ES256", { extractable: true });
  const url = `/poppy/conversations/${c.conversation_id}/events`;
  assert.equal(
    (
      await request(url, {
        session: s,
        sessionJwt: await sessionProof(
          s,
          "GET",
          url,
          undefined,
          {},
          { poppy_dlg: await delegate(rotated) },
          rotated,
        ),
      })
    ).status,
    200,
  );
});

test("OAuth client assertions use the issuer audience; reject endpoint/array audiences and replays", async () => {
  for (const aud of [company + "/oauth/token", [company], company + "/oauth/revoke"])
    await error(
      await token(
        { grant_type: "refresh_token", refresh_token: "unknown" },
        { clientAssertion: await assertion(aud) },
      ),
      401,
      "invalid_client",
    );
  const ca = await assertion();
  await error(
    await token({ grant_type: "refresh_token", refresh_token: "unknown" }, { clientAssertion: ca }),
    400,
    "invalid_grant",
  );
  await error(
    await token({ grant_type: "refresh_token", refresh_token: "unknown" }, { clientAssertion: ca }),
    401,
    "invalid_client",
  );
});

test("direct consent, decline, zero selected scopes, PKCE, single-use codes and standard token responses", async () => {
  const s = start();
  assert.equal(
    (await consent(s, "orders:read", "deny")).searchParams.get("error"),
    "access_denied",
  );
  assert.equal(
    (await consent(s, "orders:read", "approve", { selected: [] })).searchParams.get("error"),
    "access_denied",
  );
  const approved = await consent(s, "orders:read");
  assert.ok(approved.refresh_token);
  assert.equal(approved.token_type, "DPoP");
  const plain = await token({ grant_type: "refresh_token", refresh_token: approved.refresh_token });
  const response = await plain.json();
  assert.equal(plain.status, 200);
  assert.equal(response.session_id, undefined);
  assert.equal(response.signed_in, undefined);
  assert.equal((await request("/api/orders", { session: approved })).status, 200);
  await error(await token(approved.paramsToken), 400, "invalid_grant");
  const params = await consent(s, "orders:read", "approve", { exchange: false });
  await error(await token({ ...params, code_verifier: "a".repeat(43) }), 400, "invalid_grant");
  await error(await token(params), 400, "invalid_grant");
});

test("DPoP and Session ath bind signed-in requests; wrong proof method/key/hash and replays fail", async () => {
  const s = await consent(start());
  const path = "/api/orders";
  await error(
    await request(path, {
      session: s,
      sessionJwt: await sessionProof(s, "GET", path, "wrong-token"),
    }),
    400,
    "invalid_session",
  );
  const p = await dpop("GET", path, s.access_token);
  assert.equal((await request(path, { session: s, proof: p })).status, 200);
  await error(await request(path, { session: s, proof: p }), 401, "invalid_dpop_proof");
  await error(
    await request(path, { session: s, proof: await dpop("POST", path, s.access_token) }),
    401,
    "invalid_dpop_proof",
  );
  await error(
    await request(path, { session: s, key: await generateKeyPair("ES256", { extractable: true }) }),
    401,
    "invalid_dpop_proof",
  );
  await error(
    await request(path, { session: s, proof: await dpop("GET", path, "wrong") }),
    401,
    "invalid_dpop_proof",
  );
  await error(
    await request(path, { session: s, headers: { Authorization: "Bearer " + s.access_token } }),
    401,
    "invalid_token",
  );
});

test(
  "future-dated Session and DPoP proofs remain blocked after the former 65-second cache lifetime",
  { timeout: 120000 },
  async () => {
    const s = start(),
      path = "/poppy/conversations";

    const jwt = await sessionProof(s, "POST", path, undefined, { iat: now() + 59 });
    assert.equal(
      (await request(path, { method: "POST", session: s, sessionJwt: jwt, body: message() }))
        .status,
      201,
    );
    await error(
      await request(path, { method: "POST", session: s, sessionJwt: jwt, body: message() }),
      400,
      "invalid_session",
    );
    const approved = await consent(start());

    const proof = await dpop("GET", "/api/orders", approved.access_token, dpopKeys, {
      iat: now() + 59,
    });

    assert.equal((await request("/api/orders", { session: approved, proof })).status, 200);
    await error(
      await request("/api/orders", { session: approved, proof }),
      401,
      "invalid_dpop_proof",
    );
    // Real workerd time: the proofs are still fresh after the old cache entries would expire.
    await new Promise((resolve) => setTimeout(resolve, 67000));
    await error(
      await request(path, { method: "POST", session: s, sessionJwt: jwt, body: message() }),
      400,
      "invalid_session",
    );
    await error(
      await request("/api/orders", { session: approved, proof }),
      401,
      "invalid_dpop_proof",
    );
  },
);

test("scopes, resource audiences, refresh across Sessions, and immediate revocation", async () => {
  const s = await consent(start());

  const narrow = await token({
    grant_type: "refresh_token",
    refresh_token: s.refresh_token,
    scope: "orders:read",
  });

  assert.equal(narrow.status, 200);
  const n = { ...s, ...(await narrow.json()) };
  await error(
    await request("/api/orders/ord_1042/exchanges", {
      method: "POST",
      session: n,
      body: { replacement_sku: "stormline-insulated-m" },
    }),
    403,
    "insufficient_scope",
  );

  const scoped = await token({
    grant_type: "refresh_token",
    refresh_token: s.refresh_token,
    resource: company + "/poppy/conversations",
  });

  const scopedToken = await scoped.json();
  assert.equal(scoped.status, 200);
  await create({ ...s, ...scopedToken, conversation_access_token: scopedToken.access_token });

  const generic = await request("/poppy/conversations", {
    method: "POST",
    session: s,
    token: s.access_token,
    body: message(),
  });

  assert.match(generic.headers.get("WWW-Authenticate"), /resource_metadata=/);
  await error(generic, 401, "invalid_token");
  await error(
    await request("/api/orders", { session: { ...s, ...scopedToken } }),
    401,
    "invalid_token",
  );
  await error(
    await token({
      grant_type: "refresh_token",
      refresh_token: s.refresh_token,
      resource: "https://evil.test",
    }),
    400,
    "invalid_target",
  );
  assert.equal(
    (await request("/api/orders", { session: { ...s, session_id: random() } })).status,
    200,
  );

  const r = await request("/oauth/revoke", {
    method: "POST",
    body: new URLSearchParams({
      token: s.refresh_token,
      token_type_hint: "refresh_token",
      client_id: client,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: await assertion(),
    }),
  });

  assert.equal(r.status, 200);

  for (const access_token of [s.access_token, n.access_token, scopedToken.access_token])
    await error(
      await request("/api/orders", { session: { ...s, access_token } }),
      401,
      "invalid_token",
    );
  await error(
    await token({ grant_type: "refresh_token", refresh_token: s.refresh_token }),
    400,
    "invalid_grant",
  );
  await create({ user: s.user, session_id: s.session_id });
});

test("request IDs deduplicate every POST and reject changed bodies or paths, even after close", async () => {
  const s = start(),
    body = message();

  const c = await create(s, body, "");
  assert.deepEqual(Object.keys(c), ["conversation_id"]);
  assert.deepEqual(await create(s, body, "?wait=0"), c);
  await error(
    await request("/poppy/conversations", {
      method: "POST",
      session: s,
      body: { ...body, message: { ...body.message, text: "Changed" } },
    }),
    409,
    "request_id_conflict",
  );
  await error(await post(s, c, "handoff", { id: body.id }), 409, "request_id_conflict");
  const req = { id: random() };
  const h = await post(s, c, "handoff", req);
  assert.equal(h.status, 202);
  assert.deepEqual(await h.json(), c);
  const beforeAll = await (await events(s, c)).json();
  assert.equal(beforeAll.handoff, "none");
  assert.ok(beforeAll.events.some((e) => e.type === "state" && e.handoff === "pending"));
  assert.equal((await post(s, c, "handoff/cancel")).status, 202);
  assert.equal((await post(s, c, "close")).status, 202);
  assert.equal((await post(s, c, "handoff", req)).status, 202);
  const after = await (await events(s, c)).json();
  assert.equal(after.closed, true);
  assert.equal(after.handoff, "none");
  assert.equal(after.working, false);
  await error(await post(s, c, "handoff/cancel"), 409, "conversation_closed");
  assert.equal((await post(s, c, "close")).status, 202);
});

test("messages have author and request ID, account needs use insufficient_scope, and context-only updates have no reply", async () => {
  const s = start(),
    body = message("Help exchange order #1042");

  const c = await create(s, body);
  const accepted = c.events.find((e) => e.type === "message" && e.message.role === "user");
  assert.equal(accepted.message.id, body.id);
  assert.deepEqual(accepted.message.author, { type: "agent" });
  assert.equal(accepted.message.sender, undefined);
  const authorization = c.events.find((e) => e.type === "authorization");
  assert.equal(authorization.error, "insufficient_scope");
  assert.equal(authorization.scope, "orders:read orders:write");
  const reply = c.events.find((e) => e.type === "message" && e.message.role === "company");
  assert.equal(reply.message.as_of_request, body.id);

  const context = {
    id: random(),
    message: {
      id: "ignored",
      role: "company",
      author: { type: "agent" },
      context: { user_available: false },
    },
  };

  assert.equal((await post(s, c, "messages", context)).status, 202);
  const tail = await (await events(s, c, "?cursor=" + c.cursor)).json();
  assert.equal(tail.events.length, 1);
  assert.equal(tail.events[0].message.id, context.id);
  assert.equal(tail.events[0].message.role, "user");
});

test("cursor validation and pagination preserve event order without duplicates", async () => {
  const s = start(),
    c = await create(s);

  const tail = await (await events(s, c, "?cursor=" + c.cursor)).json();
  assert.deepEqual(tail.events, []);
  assert.equal(tail.cursor, c.cursor);
  assert.equal(tail.has_more, false);
  await error(await events(s, c, "?cursor=unknown"), 400, "invalid_cursor");

  for (let i = 0; i < 53; i++) assert.equal((await post(s, c, "messages", message())).status, 202);
  const page = await (await events(s, c)).json();
  assert.equal(page.events.length, 100);
  assert.equal(page.has_more, true);
  const last = await (await events(s, c, "?cursor=" + page.cursor)).json();
  assert.equal(last.has_more, false);
  assert.equal(new Set([...page.events, ...last.events].map((e) => e.id)).size, 108);
});

test("direct children, parent blocking, close cascade, and no invented human responder", async () => {
  const s = start(),
    c = await create(s);

  const child = await create(s, {
    ...message("A question", "human"),
    parent_conversation_id: c.conversation_id,
  });

  await error(await post(s, c, "messages", message()), 409, "direct_conversation_open");
  await error(await post(s, c, "handoff/cancel"), 409, "direct_conversation_open");
  await error(
    await createResponse(s, {
      ...message("Nested", "human"),
      parent_conversation_id: child.conversation_id,
    }),
    400,
    "invalid_request",
  );
  await error(await post(s, child, "messages", message()), 400, "invalid_request");
  assert.equal((await post(s, child, "handoff")).status, 202);
  const state = await (await events(s, child)).json();
  assert.equal(state.responder, "agent");
  assert.equal((await post(s, c, "close")).status, 202);
  assert.equal((await (await events(s, child)).json()).closed, true);
});

const createResponse = (s, body) =>
  request("/poppy/conversations", { method: "POST", session: s, body });

test("user_requested acceptance deduplicates the invitation even with a new request ID after close", async () => {
  const s = start(),
    c = await create(s, message("The user wants to talk directly"));

  const invite = c.events.find((e) => e.type === "user_requested");
  assert.ok(invite);

  const body = {
    id: random(),
    parent_conversation_id: c.conversation_id,
    user_requested_event_id: invite.id,
  };

  const child = await create(s, body);
  assert.equal(child.events[0].message.role, "company");
  assert.equal((await post(s, child, "close")).status, 202);
  const retry = await create(s, { ...body, id: random() });
  assert.equal(retry.conversation_id, child.conversation_id);
  await error(
    await createResponse(s, { ...body, id: random(), user_requested_event_id: "unknown" }),
    400,
    "invalid_request",
  );
});

test("account pinning applies on reads, retries, and new Sessions, and survives sign-out", async () => {
  const s = start(),
    body = message(),
    c = await create(s, body);

  const approved = await consent(s);
  assert.equal((await events(approved, c)).status, 200);
  const challenge = await events(s, c);
  assert.equal(challenge.status, 401);
  assert.match(challenge.headers.get("WWW-Authenticate"), /scope="orders:read"/);
  assert.equal((await createResponse(s, body)).status, 401);
  assert.equal((await events({ ...approved, session_id: random() }, c)).status, 200);

  for (let i = 0; i < 2; i++) {
    const exchange = await request("/api/orders/ord_1042/exchanges", {
      method: "POST",
      session: approved,
      body: { replacement_sku: "stormline-insulated-m" },
    });

    assert.equal(exchange.status, 201);
    assert.equal((await exchange.json()).exchange_id, "exc_demo_1042");
  }
});

test("malformed conversation requests, wait values, author hints and redirects fail safely", async () => {
  const s = start();

  for (const body of [
    { message: message().message },
    { id: "bad/id", message: message().message },
    { id: random() },
    { id: random(), message: { sender: "agent", text: "old format" } },
    { id: random(), message: { author: { type: "human" }, text: "hello", as_of_cursor: "evt_1" } },
  ])
    await error(await createResponse(s, body), 400, "invalid_request");

  for (const wait of ["", "-1", "1.5", "hello"])
    await error(
      await request("/poppy/conversations?wait=" + wait, {
        method: "POST",
        session: s,
        body: message(),
      }),
      400,
      "invalid_request",
    );
  assert.equal(
    (
      await request("/poppy/conversations?wait=999999", {
        method: "POST",
        session: s,
        body: message(),
      })
    ).status,
    201,
  );

  const auth = new URLSearchParams({
    client_id: client,
    redirect_uri: "https://evil.test/callback",
    response_type: "code",
  });

  await error(await request("/oauth/authorize?" + auth), 400, "invalid_redirect_uri");
  await error(
    await request("/api/orders?access_token=secret", { session: s }),
    400,
    "invalid_request",
  );
});

test("opaque IDs that match Object prototype keys remain ordinary independent IDs", async () => {
  const s = { user: "constructor", session_id: "__proto__" };
  const c = await create(s, { ...message(), id: "__proto__" });
  const other = await create(s, { ...message(), id: "constructor" }, "");
  assert.notEqual(other.conversation_id, c.conversation_id);
  await error(await events(s, { conversation_id: "constructor" }), 404, "conversation_not_found");
});
