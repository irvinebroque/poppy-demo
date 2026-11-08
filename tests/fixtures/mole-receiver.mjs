import handler from "../../workers/receiver/src/index.ts";

export * from "../../workers/receiver/src/index.ts";

let observed = [],
  last,
  eligibility,
  invite;

let mode = "normal";

// Test-only HTTP observations and fault injection around the real receiver.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/__test/policy") {
      mode = url.searchParams.get("mode");

      return Response.json({ mode });
    }

    if (url.pathname === "/.well-known/poppy.json" && mode !== "normal") {
      const response = await handler.fetch(request, env);
      const company = await response.json();

      if (mode === "unadvertised") delete company.extensions;

      if (mode === "hosted")
        company.extensions.mole[0].moderator_config_uri =
          "https://provider.test/policies/northstar/configuration";

      if (mode === "web-disabled") company.web.disabled = true;

      if (mode === "wrong-company") company.organization.domain = "other.test";

      return Response.json(company);
    }

    if (url.pathname === "/policies/northstar/configuration")
      return handler.fetch(new Request(env.RECEIVER_ORIGIN + "/mole/moderator/config"), env);

    if (url.pathname === "/mole/anchor/config" && mode === "mismatch") {
      const response = await handler.fetch(request, env);
      const config = await response.json();
      config["issuance-epoch"] = "b3RoZXItZXBvY2g";

      return Response.json(config);
    }

    if (url.pathname === "/mole/moderator/config" && mode === "redirect")
      return Response.redirect("https://other.test/credentials", 302);

    if (url.pathname === "/__test/regrant") {
      return handler.fetch(
        new Request(env.RECEIVER_ORIGIN + "/mole/anchor/grant", {
          method: "POST",
          headers: {
            "Content-Type": "application/mole-endorsement-request; type=0002",
            "Northstar-Eligibility": eligibility,
            "Northstar-Invite": invite,
          },
          body: new Uint8Array([0, 1]),
        }),
        env,
      );
    }

    if (url.pathname === "/mole/anchor/grant") {
      eligibility = request.headers.get("Northstar-Eligibility");
      invite = request.headers.get("Northstar-Invite");
    }

    if (url.pathname === "/__test/seen") return Response.json(observed);

    if (url.pathname === "/__test/replay") {
      if (!last) return new Response("", { status: 404 });
      const target = new URL(last.url);

      if (url.searchParams.has("q")) target.searchParams.set("q", url.searchParams.get("q"));

      return handler.fetch(new Request(target, { method: "POST", headers: last.headers }), env);
    }

    observed.push({
      path: url.pathname,
      headers: [...request.headers.keys()],
      scheme: request.headers.get("Authorization")?.split(" ")[0],
      body: url.pathname.startsWith("/poppy/") ? await request.clone().text() : undefined,
    });

    if (url.pathname === "/private/search" && request.headers.has("Authorization"))
      last = { url: request.url, headers: request.headers };

    const response = await handler.fetch(request, env);

    if (
      mode === "lose-asset" &&
      url.pathname === "/private/catalog.css" &&
      request.headers.has("Authorization") &&
      response.ok
    ) {
      mode = "normal";
      await response.arrayBuffer();

      return new Response("Lost asset update", { status: 503 });
    }

    return response;
  },
};
