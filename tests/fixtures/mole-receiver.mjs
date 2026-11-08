import handler from "../../workers/receiver/src/index.ts";

export * from "../../workers/receiver/src/index.ts";

let observed = [],
  last,
  eligibility;

// Test-only HTTP observations and fault injection around the real receiver.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/__test/regrant") {
      return handler.fetch(
        new Request(env.RECEIVER_ORIGIN + "/mole/anchor/grant", {
          method: "POST",
          headers: {
            "Content-Type": "application/mole-endorsement-request; type=0002",
            "Northstar-Eligibility": eligibility,
          },
          body: new Uint8Array([0, 1]),
        }),
        env,
      );
    }

    if (url.pathname === "/mole/anchor/grant")
      eligibility = request.headers.get("Northstar-Eligibility");

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

    return handler.fetch(request, env);
  },
};
