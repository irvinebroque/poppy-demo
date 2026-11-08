// Test-only authorization-server faults; all other requests use the real receiver.
export default {
  async fetch(request, env) {
    const tokenRequest = new URL(request.url).pathname === "/oauth/token";

    const grant = tokenRequest
      ? new URLSearchParams(await request.clone().text()).get("grant_type")
      : undefined;

    if (env.MODE === "reject-refresh" && grant === "refresh_token")
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    const response = await env.REAL.fetch(request);

    if (!tokenRequest || !response.ok || env.MODE === "normal") return response;
    const body = await response.json();

    if (
      env.MODE === "omit-scope" ||
      (env.MODE === "omit-refresh-scope" && grant === "refresh_token")
    )
      delete body.scope;

    if (env.MODE === "empty-scope") body.scope = "";

    if (env.MODE === "null-scope") body.scope = null;

    if (env.MODE === "unknown-scope") body.scope = "unknown:scope";

    return Response.json(body, response);
  },
};
