import { anchorAccountsSchema } from "../../../shared/mole";
import { privatePage, type PublicResource } from "./private-pages";
import { jwksSchema } from "../../../shared/schemas";
// HTTP/storage adapters around the pinned Guac implementation. No cryptographic primitives here.
import { GUAC_AVAILABLE } from "../../../vendor/guac/available";
import { DurableObject } from "cloudflare:workers";
import {
  createAnchorCrypto,
  createCrypto,
  generateSecret,
  base64url,
  type Crypto,
} from "../../../vendor/guac/runtime";
import {
  fail,
  json,
  now,
  hash,
  readText,
  verifyAssertion,
  ProtocolError,
} from "../../../shared/protocol";
import { searchCatalog } from "../../../shared/catalog";

const EPOCH = Array.from(new TextEncoder().encode("northstar-demo-v1"));
const uuid = () => crypto.randomUUID();
const PRICE = { cost: 1, allowance: 0, refund: 0 };
const bytes = (value: number[]) => Uint8Array.from(value);
const key = (value: number[]) => base64url(value);

function header(reply: ReturnType<Crypto["run"]>): string {
  if (reply.kind === "failed") fail("mole_rejected", reply.status);

  if (reply.kind !== "header") fail("mole_unavailable", 500);

  return reply.value;
}

function challenge(value: string) {
  return json({ error: "mole_required" }, 401, {
    "WWW-Authenticate": value + ', realm="northstar"',
  });
}

function updated<T>(body: T, status: number, update: string) {
  return json(body, status, { "Mole-Credential": update });
}

export class MoleAnchor extends DurableObject<ReceiverEnv> {
  private crypto?: Promise<Awaited<ReturnType<typeof createAnchorCrypto>>>;
  constructor(ctx: DurableObjectState, env: ReceiverEnv) {
    super(ctx, env);
    void this.ctx.blockConcurrencyWhile(async () => {
      if (!this.ctx.storage.kv.get("secret"))
        this.ctx.storage.kv.put("secret", await generateSecret("anchor"));
    });
  }
  private native() {
    const secret = this.ctx.storage.kv.get<string>("secret");

    if (!secret) fail("mole_unavailable", 500);

    return (this.crypto ??= createAnchorCrypto(secret, EPOCH));
  }
  async configuration() {
    return (await this.native()).configuration;
  }
  async grant(owner: string, route: string | null, request: number[]) {
    // Custom Error properties do not cross Workers RPC. Return protocol errors
    // as data, so allowance/expiry errors keep their status at the HTTP boundary.
    try {
      return { ok: true as const, ...(await this.exchange(owner, route, request)) };
    } catch (e) {
      if (e instanceof ProtocolError)
        return { ok: false as const, error: e.code, status: e.status };
      throw e;
    }
  }
  private async exchange(owner: string, route: string | null, request: number[]) {
    const crypto = await this.native();

    // No await between taking a continuation and consuming it. Failed responses consume it too.
    if (route) {
      const state = this.ctx.storage.kv.get<{ owner: string; state: number[]; expires: number }>(
        "grant:" + route,
      );

      if (!state || state.owner !== owner || state.expires < now())
        fail("grant_consumed_or_expired", 409);
      this.ctx.storage.kv.delete("grant:" + route);

      const result = crypto.run({
        kind: "anchor_respond",
        now: now(),
        state: state.state,
        request,
      });

      if (result.kind === "failed") fail("grant_rejected", result.status);

      if (result.kind !== "message") fail("mole_unavailable", 500);

      return { response: result.bytes, route };
    }

    if (request.length !== 2 || request[0] !== 0 || request[1] !== 1) fail("invalid_grant_opening");
    const last = this.ctx.storage.kv.get<number>("budget:" + owner) ?? 0;

    if (last > now() - 86400) fail("anchor_allowance_used", 429);
    const result = crypto.run({ kind: "anchor_commit", now: now() });

    if (result.kind === "failed") fail("grant_rejected", result.status);

    if (result.kind !== "anchor_committed") fail("mole_unavailable", 500);
    const id = uuid();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.put("budget:" + owner, now());
      this.ctx.storage.kv.put("grant:" + id, {
        owner,
        state: result.state,
        expires: result.expires_at,
      });
    });
    const alarm = await this.ctx.storage.getAlarm();

    if (alarm === null || alarm > result.expires_at * 1000)
      await this.ctx.storage.setAlarm(result.expires_at * 1000);

    return { response: result.response, route: id };
  }
  async alarm() {
    let next = Infinity;

    for (const [key, value] of this.ctx.storage.kv.list<{ expires: number }>({
      prefix: "grant:",
    })) {
      if (value.expires <= now()) this.ctx.storage.kv.delete(key);
      else next = Math.min(next, value.expires * 1000);
    }

    for (const [key, value] of this.ctx.storage.kv.list<number>({ prefix: "budget:" })) {
      if (value <= now() - 86400) this.ctx.storage.kv.delete(key);
      else next = Math.min(next, (value + 86400) * 1000);
    }

    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, next));
  }
}

type Accepted = {
  record: number[];
  binding: string;
  result: ReturnType<typeof searchCatalog>;
  accepted: number;
  resource?: PublicResource;
};

export class MoleModerator extends DurableObject<ReceiverEnv> {
  private crypto?: Promise<Crypto>;
  constructor(ctx: DurableObjectState, env: ReceiverEnv) {
    super(ctx, env);
    void this.ctx.blockConcurrencyWhile(async () => {
      if (!this.ctx.storage.kv.get("secret"))
        this.ctx.storage.kv.put("secret", await generateSecret("moderator"));
    });
  }
  private native() {
    return (this.crypto ??= (async () => {
      const secret = this.ctx.storage.kv.get<string>("secret");

      if (!secret) fail("mole_unavailable", 500);
      const anchor = await this.env.MOLE_ANCHOR.getByName("demo-policy").configuration();

      return createCrypto(
        secret,
        (this.env.MOLE_PROVIDER_ORIGIN || this.env.RECEIVER_ORIGIN) + "/mole/moderator/issue",
        "northstar-search-v1",
        { keys: [anchor.public_key], epoch: anchor.epoch },
        null,
      );
    })());
  }
  async configuration() {
    const crypto = await this.native();
    const anchor = await this.env.MOLE_ANCHOR.getByName("demo-policy").configuration();
    const c = crypto.configuration;

    return {
      "issuance-uri": c.endpoint,
      endorsements: [
        {
          "endorsement-type": 2,
          ciphersuite: "P256-SHA256",
          "issuance-epoch": key(anchor.epoch),
          "anchor-set": [key(anchor.public_key)],
        },
      ],
      "credential-keys": [
        {
          "credential-type": 1,
          "credential-key": key(c.public_key),
          ciphersuite: "P256-SHA256",
          "balance-width": c.balance_bits,
          "credential-context": key(c.context),
          "result-retention": Number(c.retention),
        },
      ],
    };
  }
  async issue(authorization: string): Promise<Response> {
    const crypto = await this.native();
    const operation = crypto.run({ kind: "operation", authorization });

    if (operation.kind === "failed") return json({ error: "malformed_mole" }, operation.status);

    if (operation.kind !== "operation") fail("mole_unavailable", 500);

    if (operation.operation === "recovery") {
      const n = crypto.run({ kind: "nullifier", authorization });

      const stored =
        n.kind === "nullifier"
          ? this.ctx.storage.kv.get<Accepted>("spend:" + key(n.nullifier))
          : undefined;

      if (!stored) return json({ error: "result_unavailable" }, 404);

      const recovered = crypto.run({
        kind: "recover",
        now: now(),
        authorization,
        record: stored.record,
      });

      if (recovered.kind === "failed") return json({ error: "result_unavailable" }, 404);

      return updated({ recovered: true }, 200, header(recovered));
    }

    const fresh = () => challenge(header(crypto.run({ kind: "issuance_challenge", now: now() })));

    if (operation.operation === "none") return fresh();

    if (operation.operation !== "issue") return json({ error: "malformed_mole" }, 400);
    const issued = crypto.run({ kind: "issue", now: now(), authorization });

    if (issued.kind === "failed")
      return issued.status === 401 ? fresh() : json({ error: "mole_rejected" }, issued.status);

    if (issued.kind !== "issued" || !issued.replay_id || !issued.epoch)
      fail("mole_unavailable", 500);
    const replay = "redemption:" + key(issued.epoch) + ":" + key(issued.replay_id);

    const previous = this.ctx.storage.kv.get<{ credential: string; expires: number }>(replay);

    if (previous) return previous.expires > now() ? updated({}, 200, previous.credential) : fresh();
    // An issuance retry returns the first issued credential, never a second grant.
    this.ctx.storage.kv.put(replay, { credential: issued.credential, expires: now() + 60 });

    return updated({}, 200, issued.credential);
  }
  async search(
    authorization: string,
    url: string,
    query: string,
    resource?: PublicResource,
    method = "POST",
  ): Promise<Response> {
    const crypto = await this.native();
    const binding = method + " " + url;

    const fresh = () =>
      challenge(
        header(crypto.run({ kind: "presentation_challenge", now: now(), binding, price: PRICE })),
      );

    const operation = crypto.run({ kind: "operation", authorization });

    if (operation.kind === "failed") return json({ error: "malformed_mole" }, operation.status);

    if (operation.kind !== "operation") fail("mole_unavailable", 500);

    if (operation.operation === "none") return fresh();

    if (operation.operation !== "presentation") return json({ error: "malformed_mole" }, 400);
    const n = crypto.run({ kind: "nullifier", authorization });
    const id = n.kind === "nullifier" ? "spend:" + key(n.nullifier) : undefined;
    const existing = id ? this.ctx.storage.kv.get<Accepted>(id) : undefined;

    if (existing) {
      // The exact resource request can recover its public search result. Changed queries never do.
      if (existing.binding !== binding) return fresh();

      const recovered = crypto.run({
        kind: "recover",
        now: now(),
        authorization,
        record: existing.record,
      });

      if (recovered.kind === "failed") return fresh();

      if (existing.resource)
        return new Response(existing.resource.body, {
          headers: {
            "Content-Type": existing.resource.contentType,
            "Mole-Credential": header(recovered),
            "Cache-Control": "no-store",
          },
        });

      return updated(
        { results: existing.result, accepted_searches: existing.accepted, recovered: true },
        409,
        header(recovered),
      );
    }

    const verified = crypto.run({
      kind: "verify",
      now: now(),
      authorization,
      binding,
      price: PRICE,
    });

    if (verified.kind === "failed")
      return verified.status === 401 ? fresh() : json({ error: "mole_rejected" }, verified.status);

    if (verified.kind !== "verified" || !id) fail("mole_unavailable", 500);
    // This small demo stores replay and the public search result in one transaction.
    // It has no account write or payment side effect. Do not generalize this into an order receipt.
    const result = searchCatalog(query, this.env.RECEIVER_ORIGIN);

    const accepted = this.ctx.storage.transactionSync(() => {
      const count = (this.ctx.storage.kv.get<number>("accepted") ?? 0) + 1;
      this.ctx.storage.kv.put(id, {
        record: verified.record,
        binding,
        result,
        accepted: count,
        resource,
      });
      this.ctx.storage.kv.put("accepted", count);

      return count;
    });

    if (resource)
      return new Response(resource.body, {
        headers: {
          "Content-Type": resource.contentType,
          "Mole-Credential": verified.credential,
          "Cache-Control": "no-store",
        },
      });

    return updated(
      { results: result, accepted_searches: accepted, recovered: false },
      200,
      verified.credential,
    );
  }
}

async function binaryBody(request: Request, maximum: number) {
  const chunks: Uint8Array[] = [];
  let length = 0;

  if (request.body) {
    const reader = request.body.getReader();

    try {
      for (;;) {
        const { value, done } = await reader.read();

        if (done) break;
        length += value.length;

        if (length > maximum) {
          await reader.cancel();
          fail("request_too_large", 413);
        }

        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  const result = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

export async function moleRequest(
  request: Request,
  env: ReceiverEnv,
): Promise<Response | undefined> {
  const url = new URL(request.url),
    path = url.pathname,
    origin = env.MOLE_PROVIDER_ORIGIN || env.RECEIVER_ORIGIN;

  if (!path.startsWith("/mole/") && !path.startsWith("/private/")) return;

  if (!GUAC_AVAILABLE) fail("private_search_unavailable", 503);

  if (request.method === "OPTIONS")
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "Authorization, Content-Type, X-Guac-Grant, Poppy-Extensions, Poppy-Version",
        "Cache-Control": "no-store",
      },
    });

  if (
    ["Cookie", "Session", "DPoP", "Poppy-User-ID", "Poppy-Session"].some((name) =>
      request.headers.has(name),
    )
  )
    fail("private_request_contains_identity");
  const authorization = request.headers.get("Authorization");

  if (authorization && !authorization.startsWith("Mole "))
    fail("private_request_contains_identity");

  if (path === "/mole/anchor/config" && request.method === "GET") {
    const a = await env.MOLE_ANCHOR.getByName("demo-policy").configuration();

    return json({
      "grant-uri": origin + "/mole/anchor/grant",
      "endorsement-type": 2,
      ciphersuite: "P256-SHA256",
      "anchor-key": key(a.public_key),
      "issuance-epoch": key(a.epoch),
    });
  }

  if (path === "/mole/anchor/grant" && request.method === "POST") {
    if (request.headers.get("Content-Type") !== "application/mole-endorsement-request; type=0002")
      return json({ error: "unsupported_media_type" }, 415);
    const client = env.CALLER_ORIGIN + "/agent.json";

    if (!env.CALLER) fail("temporarily_unavailable", 503);

    const jwks = await env.CALLER.fetch(env.CALLER_ORIGIN + "/jwks.json", {
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });

    const parsed = jwksSchema.safeParse(JSON.parse(await readText(jwks)));

    if (!jwks.ok || !parsed.success) fail("invalid_eligibility", 403);

    const claim = await verifyAssertion(
      request.headers.get("Northstar-Eligibility") ?? "",
      parsed.data.keys,
      client,
      origin + "/mole/anchor/grant",
    );

    const invite = request.headers.get("Northstar-Invite");

    if (!invite || claim.sub !== (await hash(invite))) fail("invalid_anchor_account", 403);

    const accounts = env.MOLE_ANCHOR_ACCOUNTS
      ? anchorAccountsSchema.parse(JSON.parse(env.MOLE_ANCHOR_ACCOUNTS))
      : env.LOCAL_DEMO === "true"
        ? [{ account: "demo-member", token: "northstar-demo-member" }]
        : [];

    const registered = new Map(
      await Promise.all(
        accounts.map(async (account) => [await hash(account.token), account.account] as const),
      ),
    );

    const account = registered.get(await hash(invite));

    if (!account) fail("anchor_account_not_eligible", 403);
    const body = await binaryBody(request, 16384);

    // Grant messages are binary; preserve every byte rather than round-tripping UTF-8.
    const result = await env.MOLE_ANCHOR.getByName("demo-policy").grant(
      account,
      request.headers.get("X-Guac-Grant"),
      Array.from(body),
    );

    if (!result.ok) fail(result.error, result.status);

    return new Response(bytes(result.response), {
      headers: {
        "Content-Type": "application/mole-endorsement-response; type=0002",
        "X-Guac-Grant": result.route,
        "Cache-Control": "no-store",
      },
    });
  }

  if (path === "/mole/moderator/config" && request.method === "GET")
    return json(await env.MOLE_MODERATOR.getByName("demo-policy").configuration());

  if (path === "/mole/moderator/issue" && request.method === "POST")
    return env.MOLE_MODERATOR.getByName("demo-policy").issue(
      request.headers.get("Authorization") ?? "",
    );

  if (request.method === "GET") {
    if (path === "/private/public")
      return json({ message: "Public information; no credential required" });

    if (path === "/private/account") return json({ error: "session_or_account_required" }, 403);

    if (path === "/private/external")
      return new Response(null, {
        status: 302,
        headers: { Location: "https://untrusted.invalid/account", "Cache-Control": "no-store" },
      });

    if (path === "/private/redirect")
      return new Response(null, {
        status: 302,
        headers: { Location: "/private/catalog", "Cache-Control": "no-store" },
      });
    const resource = privatePage(path, env.RECEIVER_ORIGIN);

    if (resource)
      return env.MOLE_MODERATOR.getByName("demo-policy").search(
        authorization ?? "",
        new URL(path, env.RECEIVER_ORIGIN).href,
        "",
        resource,
        "GET",
      );
  }

  if (path === "/private/search" && request.method === "POST") {
    const query = url.searchParams.get("q") ?? "";

    if (
      !query.trim() ||
      query.length > 80 ||
      [...url.searchParams.keys()].some((k) => k !== "q") ||
      url.searchParams.getAll("q").length !== 1 ||
      (await readText(request, 1024)).length > 0
    )
      fail("invalid_search");
    const target = new URL(path, origin);
    target.searchParams.set("q", query);

    if (url.search !== target.search) fail("noncanonical_search");

    return env.MOLE_MODERATOR.getByName("demo-policy").search(
      request.headers.get("Authorization") ?? "",
      target.href,
      query,
    );
  }

  fail("not_found", 404);
}
