import { z } from "zod";
import { idSchema, jwkSchema } from "./schemas";

export type { Message, Event, RpcResult } from "./schemas";

import {
  SignJWT,
  importJWK,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  decodeProtectedHeader,
  calculateJwkThumbprint,
  type JWK,
  type JWTPayload,
} from "jose";

export const PROTOCOL_VERSION = "0.4";
export const validId = (value: unknown): value is string => idSchema.safeParse(value).success;
export const CLIENT_ASSERTION = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
export const SCOPES = ["orders:read", "orders:write"];
const REQUEST_JWT_WINDOW = 60;
export const now = () => Math.floor(Date.now() / 1000);
export const id = (prefix = "") => prefix + crypto.randomUUID().replaceAll("-", "");

export function randomSecret() {
  return b64(crypto.getRandomValues(new Uint8Array(32)));
}

export function b64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export async function hash(value: string) {
  return b64(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
  );
}

export type KeyPair = { private: JWK; public: JWK };

export async function keyPair(): Promise<KeyPair> {
  const keys = await generateKeyPair("ES256", { extractable: true });

  return { private: await exportJWK(keys.privateKey), public: await exportJWK(keys.publicKey) };
}

export async function sign(payload: JWTPayload, keys: KeyPair, typ = "JWT", dpop = false) {
  return new SignJWT(payload)
    .setProtectedHeader({
      alg: "ES256",
      typ,
      ...(dpop ? { jwk: keys.public } : { kid: "agent-key-1" }),
    })
    .sign(await importJWK(keys.private, "ES256"));
}

export function claims(issuer: string, subject: string, audience: string): JWTPayload {
  return { iss: issuer, sub: subject, aud: audience, iat: now(), exp: now() + 60, jti: id() };
}

export function target(url: string) {
  const u = new URL(url);
  u.search = "";
  u.hash = "";

  return u.href;
}

export async function proof(
  keys: KeyPair,
  method: string,
  url: string,
  token?: string,
  nonce?: string,
) {
  return sign(
    {
      jti: id(),
      htm: method,
      htu: target(url),
      iat: now(),
      ath: token ? await hash(token) : undefined,
      nonce,
    },
    keys,
    "dpop+jwt",
    true,
  );
}

export class ProtocolError extends Error {
  constructor(
    public code: string,
    public status = 400,
    public extra: { scope?: string; resource_metadata?: string; conversation_id?: string } = {},
  ) {
    super(code);
  }
}

export function fail(code: string, status = 400, extra: ProtocolError["extra"] = {}): never {
  throw new ProtocolError(code, status, extra);
}

export function json<T>(body: T, status = 200, headers: HeadersInit = {}) {
  const responseHeaders = new Headers(headers);

  if (!responseHeaders.has("Cache-Control")) responseHeaders.set("Cache-Control", "no-store");

  return Response.json(body, { status, headers: responseHeaders });
}

export function errorResponse(cause: unknown, challenge = false) {
  const e = cause instanceof ProtocolError ? cause : new ProtocolError("server_error", 500);
  const headers: Record<string, string> = {};

  if (e.code === "account_required") {
    headers["WWW-Authenticate"] = `DPoP scope="${e.extra.scope ?? ""}"`;

    return json({}, 401, headers);
  }

  if (challenge || ["invalid_token", "invalid_dpop_proof", "insufficient_scope"].includes(e.code)) {
    headers["WWW-Authenticate"] =
      `DPoP error="${e.code}"${e.extra.scope ? `, scope="${e.extra.scope}"` : ""}${e.extra.resource_metadata ? `, resource_metadata="${e.extra.resource_metadata}"` : ""}`;
  }

  return json({ error: e.code, ...e.extra }, e.status, headers);
}

export function permittedUrl(raw: string, local: boolean) {
  const url = new URL(raw);

  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(local && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
  )
    fail("invalid_metadata");

  return url;
}

export async function readText(response: Response | Request, limit = 65536) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (done) break;
      size += value.length;

      if (size > limit) {
        await reader.cancel();
        fail("request_too_large", 413);
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return new TextDecoder().decode(bytes);
}

export async function bodyJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  try {
    return schema.parse(JSON.parse(await readText(request)));
  } catch (cause) {
    if (cause instanceof ProtocolError) throw cause;
    fail("invalid_request");
  }
}

export async function formBody(request: Request) {
  const p = new URLSearchParams(await readText(request));
  const seen = new Set<string>();

  for (const [name] of p) {
    if (seen.has(name)) fail("invalid_request");
    seen.add(name);
  }

  return p;
}

export function scopes(raw: string | null, allowed = SCOPES): string[] {
  if (!raw?.trim()) fail("invalid_scope");
  const list = [...new Set(raw.split(" "))];

  if (list.some((s) => !allowed.includes(s))) fail("invalid_scope");

  return list;
}

export async function verifyAssertion(
  jwt: string,
  keys: JWK[],
  issuer: string,
  audience: string,
  expectedSubject?: string,
) {
  try {
    const header = decodeProtectedHeader(jwt);

    if (header.alg !== "ES256" || header.typ !== "JWT") fail("invalid_grant");
    const jwk = keys.find((k) => k.kid === header.kid);

    if (!jwk || jwk.d) fail("invalid_grant");

    const { payload: raw } = await jwtVerify(jwt, await importJWK(jwk, "ES256"), {
      algorithms: ["ES256"],
      issuer,
      audience,
      clockTolerance: 5,
      requiredClaims: ["iat", "exp", "jti", "sub"],
    });

    const payload = z
      .looseObject({
        sub: z.string().min(1),
        jti: z.string().min(1),
        iat: z.number(),
        exp: z.number(),
      })
      .parse(raw);

    if (
      payload.aud !== audience ||
      !payload.sub ||
      !payload.jti ||
      !payload.iat ||
      !payload.exp ||
      payload.exp - payload.iat > 60 ||
      payload.iat > now() + 5 ||
      payload.iat < now() - 65 ||
      (expectedSubject && payload.sub !== expectedSubject)
    )
      fail("invalid_grant");

    return payload;
  } catch {
    fail("invalid_grant");
  }
}

export async function verifyProof(request: Request, token?: string) {
  try {
    const jwt = request.headers.get("DPoP");

    if (!jwt) fail("invalid_dpop_proof");
    const header = decodeProtectedHeader(jwt);

    if (
      header.typ !== "dpop+jwt" ||
      header.alg !== "ES256" ||
      !header.jwk ||
      "d" in header.jwk ||
      header.jwk.kty !== "EC" ||
      header.jwk.crv !== "P-256"
    )
      fail("invalid_dpop_proof");

    const { payload: raw } = await jwtVerify(jwt, await importJWK(header.jwk, "ES256"), {
      algorithms: ["ES256"],
      requiredClaims: ["jti", "iat"],
    });

    const payload = z
      .looseObject({
        iat: z.number(),
        jti: z.string().min(1),
        htm: z.string(),
        htu: z.string(),
        ath: z.string().optional(),
      })
      .parse(raw);

    if (
      payload.htm !== request.method ||
      payload.htu !== target(request.url) ||
      Math.abs(now() - payload.iat) > REQUEST_JWT_WINDOW ||
      !payload.jti ||
      (token && payload.ath !== (await hash(token))) ||
      (!token && payload.ath !== undefined)
    )
      fail("invalid_dpop_proof");

    return {
      thumbprint: await calculateJwkThumbprint(header.jwk),
      jti: payload.jti,
      replayExpiresAt: Math.ceil(payload.iat + REQUEST_JWT_WINDOW),
    };
  } catch {
    fail("invalid_dpop_proof", token ? 401 : 400);
  }
}

export function cookie(request: Request, name: string) {
  return request.headers
    .get("Cookie")
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(name + "="))
    ?.slice(name.length + 1);
}

export function escape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function securityHeaders(response: Response) {
  // Service and static-asset responses may have immutable headers.
  response = new Response(response.body, response);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin");
  response.headers.set("X-Frame-Options", "DENY");

  return response;
}

export type ConversationState = {
  working: boolean;
  handoff: "none" | "pending";
  responder: "agent" | "human";
  closed: boolean;
};

export type TokenResponse = {
  access_token: string;
  token_type: "DPoP";
  expires_in: number;
  scope: string;
  refresh_token?: string;
};

export async function sessionJwt(
  keys: KeyPair,
  delegation: string,
  client: string,
  audience: string,
  user: string,
  session: string,
  method: string,
  url: string,
  token?: string,
) {
  return new SignJWT({
    iss: client,
    aud: audience,
    sub: user,
    sid: session,
    htm: method,
    htu: target(url),
    iat: now(),
    jti: id(),
    ath: token ? await hash(token) : undefined,
  })
    .setProtectedHeader({
      alg: "ES256",
      typ: "poppy-session+jwt",
      kid: await calculateJwkThumbprint(keys.public),
      poppy_dlg: delegation,
    })
    .sign(await importJWK(keys.private, "ES256"));
}

export async function verifySession(
  request: Request,
  keys: JWK[],
  client: string,
  audience: string,
  token?: string,
) {
  try {
    const jwt = request.headers.get("Poppy-Session");

    if (!jwt) fail("invalid_session");
    const header = decodeProtectedHeader(jwt);

    if (
      header.alg !== "ES256" ||
      header.typ !== "poppy-session+jwt" ||
      !z.string().safeParse(header.poppy_dlg).success
    )
      fail("invalid_session");
    const delegation = z.string().parse(header.poppy_dlg);
    const dh = decodeProtectedHeader(delegation);
    const key = keys.find((k) => k.kid === dh.kid);

    if (dh.alg !== "ES256" || dh.typ !== "poppy-delegation+jwt" || !key || key.d)
      fail("invalid_session");

    const { payload: rawDelegation } = await jwtVerify(delegation, await importJWK(key, "ES256"), {
      algorithms: ["ES256"],
      issuer: client,
      requiredClaims: ["iat", "exp", "jti", "cnf"],
    });

    const dlg = z
      .looseObject({
        iat: z.number(),
        exp: z.number(),
        jti: z.string().min(1),
        cnf: z.object({ jwk: jwkSchema }),
      })
      .parse(rawDelegation);

    if (dlg.iat > now() + 5 || dlg.exp <= dlg.iat || dlg.exp - dlg.iat > 86400 || !dlg.jti)
      fail("invalid_session");
    const publicKey = dlg.cnf.jwk;

    if (
      !publicKey ||
      publicKey.d ||
      publicKey.kty !== "EC" ||
      publicKey.crv !== "P-256" ||
      header.kid !== (await calculateJwkThumbprint(publicKey))
    )
      fail("invalid_session");

    const { payload: rawSession } = await jwtVerify(jwt, await importJWK(publicKey, "ES256"), {
      algorithms: ["ES256"],
      issuer: client,
      audience,
      requiredClaims: ["sid", "sub", "htm", "htu", "iat", "jti"],
    });

    const p = z
      .looseObject({
        sub: z.string().min(1),
        sid: idSchema,
        iat: z.number(),
        jti: z.string().min(1),
        htm: z.string(),
        htu: z.string(),
        agent_id: z.string().min(1).optional(),
        ath: z.string().optional(),
      })
      .parse(rawSession);

    if (
      p.aud !== audience ||
      !validId(p.sid) ||
      !p.sub ||
      p.htm !== request.method ||
      p.htu !== target(request.url) ||
      Math.abs(now() - p.iat) > REQUEST_JWT_WINDOW ||
      !p.jti ||
      (token ? p.ath !== (await hash(token)) : p.ath !== undefined)
    )
      fail("invalid_session");

    return {
      user: p.sub,
      session: p.sid,
      jti: p.jti,
      agent: p.agent_id,
      replayExpiresAt: Math.ceil(p.iat + REQUEST_JWT_WINDOW),
    };
  } catch {
    fail("invalid_session");
  }
}
