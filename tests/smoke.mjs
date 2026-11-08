import assert from "node:assert/strict";

// Shared by isolated workerd integration tests and the live HTTPS smoke.
// This uses only the synthetic account and never logs credentials.
export async function smoke({ caller, store, fetch: send = fetch }) {
  const root = await send(caller);
  assert.equal(root.status, 200);
  const visitor = root.headers.get("set-cookie").split(";")[0];

  async function action(action, input = {}, expected = 200) {
    const r = await send(caller + "/api/action", {
      method: "POST",
      headers: { Cookie: visitor, Origin: caller, "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...input }),
    });

    const text = await r.text();
    assert.equal(r.status, expected, action + ": " + text);

    return JSON.parse(text);
  }

  let state = await action("discover");
  assert.equal(state.discovery.protocol_version, "0.4");
  state = await action("start");
  const session = state.session_id;
  const user = state.user_id;
  assert.equal(state.signed_in, false);
  assert.ok(session);
  assert.equal(
    state.traces.some((t) => t.path === "/oauth/token"),
    false,
    "signed-out Sessions need no token request",
  );
  state = await action("message", { text: "Help exchange order #1042" });
  const conversation = state.active_conversation;
  assert.ok(
    state.conversations[0].events.some(
      (e) => e.type === "authorization" && e.error === "insufficient_scope",
    ),
  );
  await action("orders", {}, 401);
  state = await action("signin");
  const pending = new URL(state.sign_in_url);

  const wrongCallback = await send(
    caller +
      "/oauth/callback?" +
      new URLSearchParams({
        state: pending.searchParams.get("state"),
        iss: "https://wrong.test",
        code: "wrong",
      }),
    { redirect: "manual", headers: { Cookie: visitor } },
  );

  assert.equal(wrongCallback.status, 400);
  const consent = await send(state.sign_in_url);
  assert.equal(consent.status, 200);
  const consentCookie = consent.headers.get("set-cookie").split(";")[0];
  const nonce = (await consent.text()).match(/name="consent_nonce" value="([^"]+)"/)[1];

  const approved = await send(store + "/oauth/authorize", {
    method: "POST",
    redirect: "manual",
    headers: {
      Cookie: consentCookie,
      Origin: store,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      consent_nonce: nonce,
      "orders:read": "yes",
      "orders:write": "yes",
      decision: "approve",
    }),
  });

  assert.equal(approved.status, 303);
  const callbackUrl = approved.headers.get("location");
  const callback = await send(callbackUrl, { redirect: "manual", headers: { Cookie: visitor } });
  assert.equal(callback.status, 303, await callback.text());
  assert.equal(
    (await send(callbackUrl, { redirect: "manual", headers: { Cookie: visitor } })).status,
    400,
  );
  state = await action("orders");
  assert.equal(state.signed_in, true);
  assert.equal(state.session_id, session);
  assert.equal(state.orders.orders[0].number, 1042);
  state = await action("message", { text: "Continue with my exchange" });
  assert.equal(state.active_conversation, conversation);
  assert.ok(
    state.traces.some(
      (t) => t.response?.token_type === "DPoP" && t.note.includes("conversation service"),
    ),
  );
  const serialized = JSON.stringify(state);
  assert.equal(serialized.includes('"access_token":"[redacted]"'), true);
  assert.equal(/"(?:private|poppy_dlg|client_assertion)":/.test(serialized), false);
  await action("propose");
  state = await action("exchange");
  assert.equal(state.exchange.exchange_id, "exc_demo_1042");
  state = await action("new-session");
  assert.notEqual(state.session_id, session);
  assert.equal(state.user_id, user);
  assert.equal(state.signed_in, true);
  state = await action("events");
  assert.equal(state.active_conversation, conversation);
  state = await action("direct", { text: "Can I ask about warmth?" });
  const child = state.active_conversation;
  assert.notEqual(child, conversation);
  state = await action("handoff");
  assert.equal(state.conversations.find((c) => c.id === child).responder, "agent");
  state = await action("handoff/cancel");
  state = await action("close");
  assert.equal(state.conversations.find((c) => c.id === child).closed, true);
  state = await action("message", { conversation, text: "Thanks for helping" });
  assert.equal(state.active_conversation, conversation);
  state = await action("revoke");
  assert.equal(state.signed_in, false);
  assert.equal(state.account_connected, false);
  await action("events", {}, 401);
  await action("orders", {}, 401);
  const fresh = await send(caller);
  const otherCookie = fresh.headers.get("set-cookie").split(";")[0];
  const other = await send(caller + "/api/state", { headers: { Cookie: otherCookie } });
  const otherState = await other.json();
  assert.notEqual(otherState.user_id, user);
  assert.deepEqual(otherState.conversations, []);

  const csrf = await send(caller + "/api/action", {
    method: "POST",
    headers: { Cookie: visitor, Origin: store, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "start" }),
  });

  assert.equal(csrf.status, 400);

  return { caller, store, conversation, visitor };
}
