import { browserLinkSchema, privateResourceSchema } from "../../../shared/mole";
import { actionSchema, promptSchema } from "../../../shared/schemas";
import {
  cookie,
  claims,
  verifyAssertion,
  randomSecret,
  bodyJson,
  json,
  fail,
  errorResponse,
  securityHeaders,
  escape,
} from "../../../shared/protocol";
import { AgentIdentity, CallerSession } from "./session";

export { AgentIdentity, CallerSession };

function visitorCookie(visitor: string, env: CallerEnv) {
  return `poppy_visitor=${visitor}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${env.LOCAL_DEMO === "true" ? "" : "; Secure"}`;
}

async function handle(request: Request, env: CallerEnv) {
  const url = new URL(request.url);

  if (url.pathname === "/agent.json" && request.method === "GET")
    return json(
      {
        client_id: env.CALLER_ORIGIN + "/agent.json",
        client_name: "Poppy Personal Agent",
        jwks_uri: env.CALLER_ORIGIN + "/jwks.json",
        redirect_uris: [env.CALLER_ORIGIN + "/oauth/callback"],
        token_endpoint_auth_method: "private_key_jwt",
      },
      200,
      { "Cache-Control": "public, max-age=300" },
    );

  if (url.pathname === "/jwks.json" && request.method === "GET")
    return json(await env.IDENTITY.getByName("signing-key").jwks(), 200, {
      "Cache-Control": "public, max-age=300",
    });

  if (url.pathname.startsWith("/assets/") && request.method === "GET")
    return env.ASSETS.fetch(request);

  if (url.pathname === "/api/private/browser-connect" && request.method === "POST") {
    if (
      request.headers.get("Origin") !== env.CALLER_ORIGIN ||
      request.headers.get("Content-Type") !== "application/json"
    )
      fail("invalid_request");
    const input = await bodyJson(request, browserLinkSchema);
    const identity = env.IDENTITY.getByName("signing-key");

    const link = await verifyAssertion(
      input.browser_token,
      (await identity.jwks()).keys,
      env.CALLER_ORIGIN + "/agent.json",
      env.CALLER_ORIGIN + "/api/private/browser-connect",
    );

    if (
      !link.sub ||
      !/^[A-Za-z0-9_-]{43}$/.test(link.sub) ||
      !link.jti ||
      !link.exp ||
      !(await identity.consumeBrowserLink(link.jti, link.exp))
    )
      fail("invalid_browser_link", 403);

    return json({ connected: true }, 200, { "Set-Cookie": visitorCookie(link.sub, env) });
  }

  let visitor = cookie(request, "poppy_visitor");
  let fresh = false;

  if (!visitor || !/^[A-Za-z0-9_-]{43}$/.test(visitor)) {
    visitor = randomSecret();
    fresh = true;
  }

  const agent = env.VISITORS.getByName(visitor);
  let response: Response;

  if (url.pathname === "/" && request.method === "GET") {
    response = new Response((await env.ASSETS.fetch(request)).body, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  } else if (url.pathname === "/oauth/callback" && request.method === "GET") {
    if (fresh) fail("missing_oauth_session");
    const result = await agent.callbackRequest(Object.fromEntries(url.searchParams));

    if (result.error)
      return new Response(
        `<p>${escape(String(result.error))}. <a href="/">Return to your agent</a></p>`,
        {
          status: 400,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        },
      );
    response = new Response(null, {
      status: 303,
      headers: { Location: "/", "Cache-Control": "no-store" },
    });
  } else if (url.pathname === "/api/state" && request.method === "GET")
    response = await agent.view();
  else if (url.pathname === "/api/pi/view" && request.method === "GET")
    response = await agent.piViewRequest();
  else if (url.pathname === "/api/agent/results" && request.method === "GET")
    response = json({ jobs: await agent.results() });
  else if (
    [
      "/api/action",
      "/api/private/resource",
      "/api/private/browser-link",
      "/api/agent/prompt",
      "/api/pi/abort",
      "/api/pi/new",
    ].includes(url.pathname) &&
    request.method === "POST"
  ) {
    if (
      fresh ||
      request.headers.get("Origin") !== env.CALLER_ORIGIN ||
      request.headers.get("Content-Type")?.split(";")[0] !== "application/json"
    )
      fail("invalid_request");

    if (url.pathname === "/api/private/browser-link") {
      response = json({
        browser_token: await env.IDENTITY.getByName("signing-key").assertion(
          claims(
            env.CALLER_ORIGIN + "/agent.json",
            visitor,
            env.CALLER_ORIGIN + "/api/private/browser-connect",
          ),
        ),
      });
    } else if (url.pathname === "/api/private/resource") {
      const input = await bodyJson(request, privateResourceSchema);
      response = await agent.privateResource(input.url);
    } else if (url.pathname === "/api/agent/prompt") {
      const b = await bodyJson(request, promptSchema);
      const r = await agent.submit(b.prompt, b.operation_id, b.when_busy ?? "followUp");
      response = json(r, 202);
    } else if (url.pathname === "/api/pi/abort") response = await agent.piAbortRequest();
    else if (url.pathname === "/api/pi/new") response = await agent.piNewRequest();
    else {
      const b = await bodyJson(request, actionSchema);
      response = await agent.actionRequest(b.action, b);
    }
  } else fail("not_found", 404);

  if (fresh) response.headers.set("Set-Cookie", visitorCookie(visitor, env));

  return response;
}

export default {
  async fetch(request, env) {
    try {
      return securityHeaders(await handle(request, env));
    } catch (e) {
      return securityHeaders(errorResponse(e));
    }
  },
} satisfies ExportedHandler<CallerEnv>;
