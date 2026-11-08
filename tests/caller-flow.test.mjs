import { guacAvailable } from "../scripts/prepare-guac.mjs";
import { snapshotSchema } from "../workers/caller/client/view-schema";
import { test, beforeAll } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildWorker } from "./build-worker.mjs";
import { Miniflare } from "miniflare";
import { smoke } from "./smoke.mjs";

let builds;

beforeAll(async () => {
  builds = await Promise.all(["caller", "receiver"].map(buildWorker));
});

async function demo(t, tokenMode = "normal") {
  const caller = "https://caller.test",
    store = "https://store.test";

  const manifest = (contents) => ({
    mainModule: "index.mjs",
    modules: { "index.mjs": { type: "esm", contents } },
  });

  const [callerBuild, receiverBuild] = builds;

  const common = {
    CALLER_ORIGIN: { type: "json", value: caller },
    RECEIVER_ORIGIN: { type: "json", value: store },
    LOCAL_DEMO: { type: "json", value: "false" },
  };

  const mf = new Miniflare({
    unsafeLocalExplorer: false,
    workers: [
      {
        config: {
          triggers: [{ type: "fetch", pattern: "caller.test/*" }],
          name: "caller",
          domains: ["caller.test"],
          compatibilityDate: "2026-10-09",
          compatibilityFlags: ["nodejs_compat"],
          manifest: callerBuild,
          exports: {
            AgentIdentity: { type: "durable-object", storage: "sqlite" },
            CallerSession: { type: "durable-object", storage: "sqlite" },
          },
          env: {
            ...common,
            IDENTITY: { type: "durable-object", worker: "caller", exportName: "AgentIdentity" },
            VISITORS: { type: "durable-object", worker: "caller", exportName: "CallerSession" },
            RECEIVER: { type: "worker", worker: "token-proxy" },
            AI: { type: "json", value: {} },
            MODEL: { type: "json", value: "@cf/moonshotai/kimi-k2.7-code" },
            ASSETS: { type: "worker", worker: "assets" },
          },
        },
      },
      {
        config: {
          triggers: [{ type: "fetch", pattern: "store.test/*" }],
          name: "receiver",
          domains: ["store.test"],
          compatibilityDate: "2026-10-09",
          compatibilityFlags: ["nodejs_compat"],
          manifest: receiverBuild,
          exports: {
            CompanyUser: { type: "durable-object", storage: "sqlite" },
            ReplayGuard: { type: "durable-object", storage: "sqlite" },
          },
          env: {
            ...common,
            OWNERS: { type: "durable-object", worker: "receiver", exportName: "CompanyUser" },
            GUARDS: { type: "durable-object", worker: "receiver", exportName: "ReplayGuard" },
            CALLER: { type: "worker", worker: "caller" },
          },
        },
      },
      {
        config: {
          name: "token-proxy",
          compatibilityDate: "2026-10-09",
          manifest: manifest(
            await readFile(new URL("./fixtures/token-proxy.mjs", import.meta.url), "utf8"),
          ),
          env: {
            REAL: { type: "worker", worker: "receiver" },
            MODE: { type: "json", value: tokenMode },
          },
        },
      },
      {
        config: {
          name: "assets",
          compatibilityDate: "2026-10-09",
          manifest: manifest(
            'export default { fetch() { return new Response("<!doctype html><title>Caller test</title>"); } }',
          ),
        },
      },
    ],
  });

  t.onTestFinished(() => mf.dispose());

  const callerWorker = await mf.getWorker("caller"),
    receiver = await mf.getWorker("receiver");

  return {
    caller,
    store,
    fetch: (url, init) =>
      new URL(url).origin === caller ? callerWorker.fetch(url, init) : receiver.fetch(url, init),
  };
}

async function session({ caller, store, fetch: send }) {
  const root = await send(caller);
  const visitor = root.headers.get("set-cookie").split(";")[0];
  const headers = { Cookie: visitor };

  async function action(action, input = {}, expected = 200) {
    const response = await send(caller + "/api/action", {
      method: "POST",
      headers: { ...headers, Origin: caller, "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...input }),
    });

    const body = await response.json();
    assert.equal(response.status, expected, action + ": " + JSON.stringify(body));

    return body;
  }

  const state = async () => (await send(caller + "/api/state", { headers })).json();

  const callback = (params) =>
    send(caller + "/oauth/callback?" + new URLSearchParams(params), {
      redirect: "manual",
      headers,
    });

  async function approve(selected = ["orders:read", "orders:write"]) {
    const pending = await action("signin");
    const consent = await send(pending.sign_in_url);
    assert.equal(consent.status, 200);
    const consentCookie = consent.headers.get("set-cookie").split(";")[0];
    const nonce = (await consent.text()).match(/name="consent_nonce" value="([^"]+)"/)[1];

    const response = await send(store + "/oauth/authorize", {
      method: "POST",
      redirect: "manual",
      headers: {
        Cookie: consentCookie,
        Origin: store,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        consent_nonce: nonce,
        decision: "approve",
        ...Object.fromEntries(selected.map((scope) => [scope, "yes"])),
      }),
    });

    assert.equal(response.status, 303);

    return send(response.headers.get("location"), { redirect: "manual", headers });
  }

  await action("discover");
  await action("start");

  return { action, state, callback, approve };
}

test("real caller and receiver Workers complete the synthetic account flow through service bindings", async (t) => {
  await smoke(await demo(t));
});

test("omitted scope works through sign-in, resource-specific tokens and refresh", async (t) => {
  await smoke(await demo(t, "omit-scope"));
});

test("failed reauthentication preserves the existing account and conversation", async (t) => {
  const environment = await demo(t),
    s = await session(environment);

  assert.equal((await s.approve()).status, 303);
  await s.action("orders");
  const previous = await s.action("message", { text: "Look up my order" });
  const pending = new URL((await s.action("signin")).sign_in_url);

  const failed = await s.callback({
    state: pending.searchParams.get("state"),
    iss: environment.store,
    code: "expired-or-invalid-code",
  });

  assert.equal(failed.status, 400);
  assert.match(await failed.text(), /invalid_grant/);
  const after = await s.state();
  assert.equal(after.signed_in, true);
  assert.equal(after.account_connected, true);
  assert.equal(after.expires_at, previous.expires_at);
  assert.equal(after.scope, previous.scope);
  assert.deepEqual(after.orders, previous.orders);
  assert.equal(after.active_conversation, previous.active_conversation);
  await s.action("renew");
  const continued = await s.action("message", { text: "Continue with my order" });
  assert.equal(continued.active_conversation, previous.active_conversation);
});

test("invalid_grant on refresh still disconnects the account", async (t) => {
  const s = await session(await demo(t, "reject-refresh"));
  assert.equal((await s.approve()).status, 303);
  assert.equal((await s.state()).account_connected, true);
  assert.equal((await s.action("renew", {}, 400)).error, "invalid_grant");
  const after = await s.state();
  assert.equal(after.signed_in, false);
  assert.equal(after.account_connected, false);
  await s.action("orders", {}, 401);
});

test("omitted refresh scope preserves a grant narrowed by consent", async (t) => {
  const s = await session(await demo(t, "omit-refresh-scope"));
  assert.equal((await s.approve(["orders:read"])).status, 303);
  assert.equal((await s.action("orders")).scope, "orders:read");
  assert.equal((await s.action("renew")).scope, "orders:read");
  const state = await s.action("message", { text: "Look up my order" });
  assert.equal(state.scope, "orders:read");
  assert.equal(
    state.conversations[0].events.some((e) => e.type === "authorization"),
    false,
  );
  assert.equal((await s.action("propose", {}, 403)).error, "insufficient_scope");
});

test("explicit empty, null and unknown response scopes are rejected", async (t) => {
  for (const mode of ["empty-scope", "null-scope", "unknown-scope"]) {
    const s = await session(await demo(t, mode));
    const response = await s.approve();
    assert.equal(response.status, 400);
    assert.match(await response.text(), /invalid_token_response/);
    assert.equal((await s.state()).account_connected, false);
  }
});

test("Pi snapshots expose a validated display view across session resets", async (t) => {
  const environment = await demo(t);
  const root = await environment.fetch(environment.caller);
  const headers = { Cookie: root.headers.get("set-cookie").split(";")[0] };

  const read = async () => {
    const response = await environment.fetch(environment.caller + "/api/pi/view", { headers });
    assert.equal(response.status, 200);

    return snapshotSchema.parse(await response.json());
  };

  const initial = await read();
  assert.deepEqual(initial.view.messages, []);
  assert.equal(initial.view.running, false);
  assert.ok(initial.tools.some((tool) => tool.name === "poppy"));

  const reset = await environment.fetch(environment.caller + "/api/pi/new", {
    method: "POST",
    headers: { ...headers, Origin: environment.caller, "Content-Type": "application/json" },
    body: "{}",
  });

  assert.equal(reset.status, 200);
  const next = await read();
  assert.notEqual(next.session, initial.session);
  assert.deepEqual(next.view.messages, []);
  assert.equal(next.approval.exchange_proposed, false);
});

test("caller rejects malformed browser commands before dispatch", async (t) => {
  const environment = await demo(t);
  const root = await environment.fetch(environment.caller);

  const headers = {
    Cookie: root.headers.get("set-cookie").split(";")[0],
    Origin: environment.caller,
    "Content-Type": "application/json",
  };

  for (const body of [
    null,
    [],
    { action: "message", text: {} },
    { action: "message", sender: "system" },
    { action: "message", conversation: [] },
  ]) {
    const response = await environment.fetch(environment.caller + "/api/action", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid_request");
  }

  for (const body of [
    { prompt: {}, operation_id: "op" },
    { prompt: "Hello", operation_id: [] },
    { prompt: "Hello", operation_id: "op", when_busy: "invalid" },
  ]) {
    const response = await environment.fetch(environment.caller + "/api/agent/prompt", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid_request");
  }
});

test(
  "public checkout keeps private search unavailable without Guac",
  { skip: await guacAvailable() },
  async (t) => {
    const setup = await demo(t);
    const { action, state } = await session(setup);
    assert.equal((await state()).private_access.available, false);
    const tools = await (await setup.fetch(setup.caller + "/api/pi/view")).json();
    assert.doesNotMatch(tools.tools[0].description, /shortlist|private search/i);
    assert.equal(
      (await action("private-search", { text: "jacket" }, 503)).error,
      "private_search_unavailable",
    );

    const response = await setup.fetch(setup.store + "/private/search?q=jacket", {
      method: "POST",
    });

    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "private_search_unavailable");
  },
);
