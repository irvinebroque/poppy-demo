import { test, beforeAll, afterAll, describe } from "vite-plus/test";
import assert from "node:assert/strict";
import { Miniflare } from "miniflare";
import { guacAvailable } from "../scripts/prepare-guac.mjs";
import { chromium } from "playwright";
import { privateContext } from "../scripts/browser/private-context.ts";
import { buildWorkerManifest } from "./build-worker.mjs";

describe("real Guac MOLE integration", { skip: !(await guacAvailable()) }, () => {
  const store = "https://store.test",
    caller = "https://agent.test";

  const text = (value) => ({ type: "json", value });
  const object = (worker, exportName) => ({ type: "durable-object", worker, exportName });
  const durable = { type: "durable-object", storage: "sqlite" };
  let mf, agent, receiver, options;
  let cookie;
  let nextAccount = 0;

  const accounts = Array.from({ length: 20 }, (_, i) => ({
    account: `member-${i}`,
    token: `test-invitation-member-${i}`,
  }));

  async function api(path, body) {
    const headers = new Headers();

    if (cookie) headers.set("Cookie", cookie);

    if (body) {
      headers.set("Origin", caller);
      headers.set("Content-Type", "application/json");
    }

    const response = await agent.fetch(caller + path, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (response.headers.has("Set-Cookie")) {
      cookie = response.headers.get("Set-Cookie").split(";")[0];
      const signedIn = await action("anchor-access", { invite: accounts[nextAccount++].token });
      assert.equal(signedIn.status, 200);
    }

    return { status: response.status, body: await response.json() };
  }

  async function action(action, extra = {}) {
    return api("/api/action", { action, ...extra });
  }

  async function seen() {
    return (await receiver.fetch(store + "/__test/seen")).json();
  }

  beforeAll(async () => {
    const [receiverManifest, callerManifest] = await Promise.all([
      buildWorkerManifest("tests/fixtures/mole-receiver.mjs"),
      buildWorkerManifest("workers/caller/src/index.ts"),
    ]);

    options = {
      upstream: caller,
      unsafeLocalExplorer: false,
      workers: [
        {
          config: {
            name: "caller",
            domains: ["agent.test"],
            triggers: [{ type: "fetch", pattern: "agent.test/*" }],
            compatibilityDate: "2026-10-09",
            compatibilityFlags: ["nodejs_compat"],
            manifest: callerManifest,
            exports: { AgentIdentity: durable, CallerSession: durable },
            env: {
              CALLER_ORIGIN: text(caller),
              RECEIVER_ORIGIN: text(store),
              LOCAL_DEMO: text("false"),
              MODEL: text("@cf/moonshotai/kimi-k2.7-code"),
              IDENTITY: object("caller", "AgentIdentity"),
              VISITORS: object("caller", "CallerSession"),
              RECEIVER: { type: "worker", worker: "receiver" },
              ASSETS: { type: "worker", worker: "empty" },
              AI: { type: "worker", worker: "empty" },
            },
          },
        },
        {
          config: {
            name: "receiver",
            domains: ["store.test"],
            triggers: [{ type: "fetch", pattern: "store.test/*" }],
            compatibilityDate: "2026-10-09",
            compatibilityFlags: ["nodejs_compat"],
            manifest: receiverManifest,
            exports: {
              CompanyUser: durable,
              ReplayGuard: durable,
              MoleAnchor: durable,
              MoleModerator: durable,
            },
            env: {
              CALLER_ORIGIN: text(caller),
              RECEIVER_ORIGIN: text(store),
              LOCAL_DEMO: text("false"),
              CALLER: { type: "worker", worker: "caller" },
              OWNERS: object("receiver", "CompanyUser"),
              GUARDS: object("receiver", "ReplayGuard"),
              MOLE_ANCHOR_ACCOUNTS: text(JSON.stringify(accounts)),
              MOLE_ANCHOR: object("receiver", "MoleAnchor"),
              MOLE_MODERATOR: object("receiver", "MoleModerator"),
            },
          },
        },
        {
          config: {
            name: "empty",
            compatibilityDate: "2026-10-09",
            manifest: {
              mainModule: "index.mjs",
              modules: {
                "index.mjs": {
                  type: "esm",
                  contents: `export default {fetch(){return new Response('No model inference in these tests',{status:503})}}`,
                },
              },
            },
          },
        },
      ],
    };
    mf = new Miniflare(options);
    agent = await mf.getWorker("caller");
    receiver = await mf.getWorker("receiver");
  });
  afterAll(async () => {
    await mf?.dispose();
  });

  test("private search, durable recovery, optional Sessions and account isolation", async () => {
    const initial = await api("/api/state");
    assert.equal(initial.status, 200);
    assert.equal(initial.body.user_id, undefined);
    assert.equal(initial.body.session_id, undefined);
    const search = await action("private-search", { text: "warmer jacket" });
    assert.equal(search.status, 200, JSON.stringify(search.body));
    assert.equal(search.body.private_access.balance, 23);
    assert.equal(search.body.private_access.results[0].id, "stormline-insulated");
    assert.equal(search.body.private_access.accepted_searches, 1);
    let state = (await api("/api/state")).body;
    assert.equal(state.user_id, undefined);
    assert.equal(state.session_id, undefined);
    const privateRequests = await seen();
    assert.equal(
      privateRequests.some((r) => r.path.startsWith("/oauth/") || r.path.startsWith("/poppy/")),
      false,
    );

    for (const r of privateRequests.filter((r) => r.path === "/private/search")) {
      for (const h of [
        "cookie",
        "dpop",
        "northstar-eligibility",
        "poppy-user-id",
        "poppy-session",
        "poppy-version",
      ])
        assert.equal(r.headers.includes(h), false);
      assert.ok(r.scheme === undefined || r.scheme === "Mole");
    }

    const regrant = await receiver.fetch(store + "/__test/regrant");
    assert.equal(regrant.status, 429);
    assert.equal((await regrant.json()).error, "anchor_allowance_used");
    assert.equal((await action("discover")).status, 200);
    assert.equal((await action("start")).status, 200);
    const lost = await action("private-search", { text: "waterproof jacket", lose_response: true });
    assert.equal(lost.status, 200, JSON.stringify(lost.body));
    assert.equal(lost.body.private_access.pending, true);
    assert.equal(lost.body.private_access.balance, null);
    assert.equal(
      (await action("private-search", { text: "new query" })).body.error,
      "recover_search_first",
    );
    assert.equal(
      (await action("remember-shortlist", { product_ids: ["stormline-shell"] })).body.error,
      "recover_search_first",
    );
    assert.equal((await seen()).filter((r) => r.path === "/mole/anchor/grant").length, 2);
    // Destroy the in-memory wallet, queue and Wasm instance. Durable continuation survives.
    options.workers[0].config.manifest.modules["index.mjs"].contents +=
      "\n// restart the caller isolate";
    await mf.setOptions(options);
    agent = await mf.getWorker("caller");
    receiver = await mf.getWorker("receiver");
    const recovered = await action("recover-private-search");
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    assert.equal(recovered.body.private_access.pending, false);
    assert.equal(recovered.body.private_access.balance, 22);
    assert.equal(recovered.body.private_access.accepted_searches, 2);
    assert.equal(recovered.body.private_access.recovered, true);
    const duplicate = await receiver.fetch(store + "/__test/replay");
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).accepted_searches, 2);
    const tampered = await receiver.fetch(store + "/__test/replay?q=warm");
    assert.equal(tampered.status, 401);
    assert.equal((await action("recover-private-search")).body.error, "no_pending_search");
    // A new Pi conversation preserves the visitor's allowance.
    assert.equal((await api("/api/pi/new", {})).status, 200);
    assert.equal((await api("/api/state")).body.private_access.balance, 22);

    const parallel = await Promise.all([
      action("private-search", { text: "jacket" }),
      action("private-search", { text: "warm" }),
    ]);

    assert.deepEqual(
      parallel.map((r) => r.status),
      [200, 200],
    );
    state = (await api("/api/state")).body;
    assert.equal(state.private_access.balance, 20);
    assert.equal(state.private_access.accepted_searches, 4);
    assert.equal((await seen()).filter((r) => r.path === "/mole/anchor/grant").length, 0);
    assert.equal(
      (await action("remember-shortlist", { product_ids: ["not-a-result"] })).status,
      400,
    );
    const shared = await action("remember-shortlist", { product_ids: ["stormline-insulated"] });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.equal(shared.body.private_access.shared, true);
    assert.match(shared.body.user_id, /^usr_/);
    assert.ok(shared.body.session_id);
    assert.equal(shared.body.signed_in, false);
    assert.equal(shared.body.private_access.balance, 20);
    const disclosure = (await seen()).filter((r) => r.path === "/poppy/conversations");
    assert.equal(disclosure.length, 1);
    assert.ok(disclosure[0].headers.includes("poppy-session"));
    assert.equal(disclosure[0].headers.includes("authorization"), false);
    assert.equal(
      (await seen()).some((r) => r.path.startsWith("/oauth/")),
      false,
    );
    const request = JSON.parse(disclosure[0].body);
    assert.match(request.id, /^shortlist_/);
    const message = request.message;
    assert.match(message.text, /Stormline Insulated Jacket/);

    for (const secret of ["warm", "balance", "anchor_", "Mole", "query"])
      assert.equal(message.text.includes(secret), false);
    assert.deepEqual(Object.keys(message).sort(), ["author", "text"]);
    await action("remember-shortlist", { product_ids: ["stormline-insulated"] });
    assert.equal((await seen()).filter((r) => r.path === "/poppy/conversations").length, 1);
    // Existing continuity never attaches credentials to later private searches.
    const later = await action("private-search", { text: "jacket" });
    assert.equal(later.status, 200);

    for (const r of (await seen()).filter((r) => r.path === "/private/search")) {
      for (const h of ["cookie", "dpop", "northstar-eligibility", "poppy-session", "poppy-version"])
        assert.equal(r.headers.includes(h), false);
      assert.ok(r.scheme === undefined || r.scheme === "Mole");
    }

    // Consume the remainder, then verify the caller does not silently discard a
    // zero-balance credential or acquire another grant.
    for (let remaining = 18; remaining >= 0; remaining--) {
      const spent = await action("private-search", { text: "jacket" });
      assert.equal(spent.status, 200);
      assert.equal(spent.body.private_access.balance, remaining);
    }

    assert.equal(
      (await action("private-search", { text: "jacket" })).body.error,
      "private_allowance_exhausted",
    );
    assert.equal((await seen()).filter((r) => r.path === "/mole/anchor/grant").length, 0);
    assert.equal((await api("/api/state")).body.private_access.balance, 0);
    assert.equal((await action("orders")).status, 401);
    assert.equal((await action("exchange")).body.error, "review_exchange_first");
  });

  test("private endpoints reject Poppy identity, canonicalize requests, and never authorize orders", async () => {
    for (const header of ["Cookie", "DPoP", "Poppy-User-ID", "Poppy-Session", "Session"]) {
      const r = await receiver.fetch(store + "/private/search?q=warm", {
        method: "POST",
        headers: { [header]: "secret" },
      });

      assert.equal(r.status, 400);
      assert.equal((await r.json()).error, "private_request_contains_identity");
    }

    const declared = await receiver.fetch(store + "/private/search?q=warm", {
      method: "POST",
      headers: { "Poppy-Version": "0.4", "Poppy-Extensions": '"mole";v="1"' },
    });

    assert.equal(declared.status, 401, await declared.clone().text());
    assert.match(declared.headers.get("WWW-Authenticate"), /^Mole /);
    const preflight = await receiver.fetch(store + "/private/search", { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "*");
    assert.match(preflight.headers.get("Access-Control-Expose-Headers"), /Mole-Credential/);

    assert.equal(
      (await receiver.fetch(store + "/private/search?q=warm&q=cold", { method: "POST" })).status,
      400,
    );
    assert.equal(
      (await receiver.fetch(store + "/private/search?q=warm%20jacket", { method: "POST" })).status,
      400,
    );
    assert.equal(
      (await receiver.fetch(store + "/private/search?q=warm", { method: "POST", body: "changed" }))
        .status,
      400,
    );
    assert.equal(
      (await receiver.fetch(store + "/api/orders", { headers: { Authorization: "Mole fake" } }))
        .status,
      400,
    );
  });

  test("concurrent visitors keep independent wallets and do not inherit Poppy continuity", async () => {
    const visitors = await Promise.all(
      [0, 1].map(async () => {
        const r = await agent.fetch(caller + "/api/state");

        return r.headers.get("Set-Cookie").split(";")[0];
      }),
    );

    assert.notEqual(visitors[0], visitors[1]);

    const replies = await Promise.all(
      visitors.map(async (visitor, i) => {
        const provisioned = await agent.fetch(caller + "/api/action", {
          method: "POST",
          headers: { Cookie: visitor, Origin: caller, "Content-Type": "application/json" },
          body: JSON.stringify({ action: "anchor-access", invite: accounts[nextAccount++].token }),
        });

        assert.equal(provisioned.status, 200);

        const r = await agent.fetch(caller + "/api/action", {
          method: "POST",
          headers: { Cookie: visitor, Origin: caller, "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "private-search",
            text: i ? "waterproof jacket" : "warmer jacket",
          }),
        });

        assert.equal(r.status, 200);

        return r.json();
      }),
    );

    assert.deepEqual(
      replies.map((r) => r.private_access.balance),
      [23, 23],
    );
    assert.deepEqual(
      replies.map((r) => r.private_access.results.length),
      [1, 2],
    );

    for (const visitor of visitors) {
      const state = await (
        await agent.fetch(caller + "/api/state", { headers: { Cookie: visitor } })
      ).json();

      assert.equal(state.user_id, undefined);
      assert.equal(state.session_id, undefined);
    }

    assert.equal((await api("/api/state")).body.private_access.balance, 0);
  });

  test("signed-in Poppy 0.4 account credentials stay out of MOLE requests", async () => {
    // Use a new visitor so the previous test's intentionally exhausted wallet stays intact.
    const oldCookie = cookie;
    cookie = undefined;

    try {
      assert.equal((await api("/api/state")).status, 200);
      assert.equal((await action("discover")).body.discovery.protocol_version, "0.4");
      const started = await action("start");
      const session = started.body.session_id;
      assert.ok(session);
      assert.equal(started.body.signed_in, false);
      const signin = await action("signin");
      assert.equal(signin.status, 200);
      const page = await receiver.fetch(signin.body.sign_in_url);
      assert.equal(page.status, 200);
      const consentCookie = page.headers.get("Set-Cookie").split(";")[0];
      const html = await page.text();
      const nonce = html.match(/name="consent_nonce" value="([^"]+)"/)[1];

      const approved = await receiver.fetch(store + "/oauth/authorize", {
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
          "orders:read": "yes",
          "orders:write": "yes",
        }),
      });

      assert.equal(approved.status, 303, await approved.text());

      const callback = await agent.fetch(approved.headers.get("Location"), {
        headers: { Cookie: cookie },
        redirect: "manual",
      });

      assert.equal(callback.status, 303);
      let state = (await api("/api/state")).body;
      assert.equal(state.signed_in, true);
      assert.equal(state.session_id, session);
      assert.equal(state.account_connected, true);
      assert.equal((await action("orders")).status, 200);
      // A valid Session and OAuth token must still never accompany private search.
      const privateResult = await action("private-search", { text: "warm jacket" });
      assert.equal(privateResult.status, 200);
      assert.equal(privateResult.body.private_access.balance, 23);
      const requests = await seen();
      const privateRequest = requests.filter((r) => r.path === "/private/search").at(-1);
      assert.equal(privateRequest.scheme, "Mole");

      for (const h of ["cookie", "dpop", "poppy-session", "poppy-version"])
        assert.equal(privateRequest.headers.includes(h), false);
      const signedRequest = requests.filter((r) => r.path === "/api/orders").at(-1);
      assert.equal(signedRequest.scheme, "DPoP");
      assert.ok(signedRequest.headers.includes("poppy-session"));
      assert.ok(signedRequest.headers.includes("dpop"));
    } finally {
      cookie = oldCookie;
    }
  });
  test("agents can share results and choose fresh anonymous Sessions without shortlist approval", async () => {
    cookie = undefined;
    await api("/api/state");
    const searched = await action("private-search", { text: "warmer jacket" });
    assert.equal(searched.status, 200);
    const started = await action("start");
    assert.equal(started.status, 200);

    const message = await action("message", {
      text: "Compare the Stormline Insulated Jacket from my search",
      sender: "agent",
    });

    assert.equal(message.status, 200, JSON.stringify(message.body));
    const anonymous = await action("anonymous-session");
    assert.equal(anonymous.status, 200);
    assert.notEqual(anonymous.body.user_id, started.body.user_id);
    assert.notEqual(anonymous.body.session_id, started.body.session_id);
    assert.equal(anonymous.body.private_access.balance, 23);
  });

  test("clearing visitor state cannot remint an Anchor account's allowance", async () => {
    cookie = undefined;
    await api("/api/state");
    await action("anchor-access", { invite: accounts[0].token });
    const refused = await action("private-search", { text: "jacket" });
    assert.equal(refused.status, 429);
    assert.equal(refused.body.error, "anchor_allowance_used");
    assert.equal((await api("/api/state")).body.session_id, undefined);
    assert.equal((await api("/api/state")).body.private_access.balance, null);
  });

  test("private Chromium handles navigations, redirects, CSS and images without identity or joins", async () => {
    cookie = undefined;
    await api("/api/state");
    await action("start");
    const linked = await api("/api/private/browser-link", {});
    assert.equal(linked.status, 200);

    const connect = () =>
      agent.fetch(caller + "/api/private/browser-connect", {
        method: "POST",
        headers: { Origin: caller, "Content-Type": "application/json" },
        body: JSON.stringify(linked.body),
      });

    const connection = await connect();
    assert.equal(connection.status, 200);
    assert.equal(connection.headers.get("Set-Cookie").split(";")[0], cookie);
    assert.equal((await connect()).status, 403);
    const browser = await chromium.launch();

    const request = (url) =>
      agent.fetch(caller + "/api/private/resource", {
        method: "POST",
        redirect: "manual",
        headers: { Cookie: cookie, Origin: caller, "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

    try {
      const ordinary = await browser.newContext();
      await ordinary.addCookies([
        { name: "account", value: "identified", domain: "store.test", path: "/" },
      ]);
      const context = await privateContext(browser, store, request);
      assert.deepEqual(await context.cookies(), []);
      const page = await context.newPage();
      const response = await page.goto(store + "/private/catalog");
      assert.equal(response.status(), 200);
      assert.equal(response.headers()["mole-credential"], undefined);
      assert.match(await page.locator("h1").textContent(), /Northstar jackets/);
      assert.equal(
        await page.locator("img").evaluate((image) => image.complete && image.naturalWidth > 0),
        true,
      );
      assert.equal(
        await page.locator("body").evaluate((body) => getComputedStyle(body).backgroundColor),
        "rgb(245, 244, 239)",
      );
      const before = (await api("/api/state")).body.private_access.balance;
      assert.equal(before, 21);
      await page.goto(store + "/private/redirect");
      assert.equal(page.url(), store + "/private/catalog");
      assert.equal((await api("/api/state")).body.private_access.balance, 18);
      const refused = await page.goto(store + "/private/account");
      assert.equal(refused.status(), 403);
      const blocked = await context.newPage();
      await assert.rejects(blocked.goto(store + "/private/external"), /ERR_BLOCKED_BY_CLIENT/);
      await blocked.close();
      const publicPage = await page.goto(store + "/products/stormline-shell");
      assert.equal(publicPage.status(), 200);
      assert.equal((await api("/api/state")).body.private_access.balance, 18);
      assert.deepEqual(await context.cookies(), []);

      const observed = (await seen()).filter((entry) =>
        ["/private/catalog", "/private/catalog.css", "/private/jacket.svg"].includes(entry.path),
      );

      for (const path of ["/private/catalog", "/private/catalog.css", "/private/jacket.svg"]) {
        assert.ok(observed.some((entry) => entry.path === path && entry.scheme === "Mole"));
      }

      for (const entry of observed) {
        for (const name of [
          "cookie",
          "poppy-session",
          "dpop",
          "northstar-invite",
          "northstar-eligibility",
        ])
          assert.equal(entry.headers.includes(name), false);
      }

      await context.close();
      const reopened = await privateContext(browser, store, request);
      const next = await reopened.newPage();
      await next.goto(store + "/private/catalog");
      assert.equal((await api("/api/state")).body.private_access.balance, 15);
      await reopened.close();
      await receiver.fetch(store + "/__test/policy?mode=lose-asset");
      assert.equal((await request(store + "/private/catalog.css")).status, 500);
      assert.equal((await api("/api/state")).body.private_access.pending, true);
      await mf.setOptions(options);
      agent = await mf.getWorker("caller");
      receiver = await mf.getWorker("receiver");
      const recovered = await request(store + "/private/catalog.css");
      assert.equal(recovered.status, 200);
      assert.match(await recovered.text(), /background/);
      assert.equal((await api("/api/state")).body.private_access.balance, 14);
      await ordinary.close();
    } finally {
      await browser.close();
    }
  });

  test("hosted configuration, trusted configuration without advertisements, and failure policies", async () => {
    options.workers[0].config.env.MOLE_PROVIDER_ORIGIN = text("https://provider.test");
    options.workers[0].config.env.MOLE_PROVIDER = { type: "worker", worker: "receiver" };
    options.workers[0].config.env.MOLE_MODERATOR_CONFIG_URI = text(
      store + "/mole/moderator/config",
    );
    await mf.setOptions(options);
    agent = await mf.getWorker("caller");
    receiver = await mf.getWorker("receiver");

    for (const mode of [
      "hosted",
      "unadvertised",
      "mismatch",
      "redirect",
      "wrong-company",
      "web-disabled",
    ]) {
      options.workers[1].config.env.MOLE_PROVIDER_ORIGIN = text(
        mode === "hosted" ? "https://provider.test" : "",
      );
      options.workers[0].config.env.MOLE_ANCHOR_CONFIG_URI = text(
        (mode === "hosted" ? "https://provider.test" : store) + "/mole/anchor/config",
      );
      await mf.setOptions(options);
      agent = await mf.getWorker("caller");
      receiver = await mf.getWorker("receiver");
      await receiver.fetch(store + "/__test/policy?mode=" + mode);
      cookie = undefined;
      await api("/api/state");

      if (mode === "web-disabled") {
        const response = await agent.fetch(caller + "/api/private/resource", {
          method: "POST",
          headers: { Cookie: cookie, Origin: caller, "Content-Type": "application/json" },
          body: JSON.stringify({ url: store + "/private/catalog" }),
        });

        assert.equal(response.status, 403);
        assert.equal((await response.json()).error, "company_disables_browsing");
        continue;
      }

      const response = await action("private-search", { text: "jacket" });

      if (["hosted", "unadvertised"].includes(mode)) {
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.body.private_access.balance, 23);

        if (mode === "hosted") {
          const requests = await seen();

          for (const path of ["/mole/anchor/grant", "/mole/moderator/issue"])
            assert.ok(
              requests.some(
                (entry) => entry.path === path && entry.origin === "https://provider.test",
              ),
            );
        }
      } else {
        assert.equal(
          response.status,
          mode === "wrong-company" ? 400 : 409,
          JSON.stringify(response.body),
        );
        assert.equal((await api("/api/state")).body.session_id, undefined);

        if (mode !== "wrong-company") assert.equal((await action("start")).status, 200);
      }
    }

    await receiver.fetch(store + "/__test/policy?mode=normal");
  });
});
