# Poppy on Cloudflare Workers

A two-Worker demo of the [Personal Agent Protocol draft 0.1](https://personalagentprotocol.org/docs/spec). The personal agent uses Cloudflare's [PiHarness integration](https://developers.cloudflare.com/changelog/post/2026-10-02-pi-harness/) with Pi Durable, Agents SDK, and Workers AI. Northstar Outfitters is the fictional receiving website.

- **Caller:** https://poppy-caller.roundtrip.workers.dev
- **Receiving website:** https://poppy-receiver.roundtrip.workers.dev

## Try it

1. On the caller, choose **Explore jackets**, then send the prompt. Pi discovers the receiving website, starts a signed-out session, and talks to its agent.
2. Ask to exchange order #1042. Pi requests account access and pauses for you.
3. Choose **Sign in at Northstar** in the conversation. Approve the synthetic account and select its read/write permissions. You return to the same chat.
4. Ask Pi to continue. Review the exchange and choose **Confirm demo exchange**. This simulates an exchange with a $70 difference; no purchase, charge, or shipment occurs.
5. Ask Pi to revoke access whenever you want. **New session** starts a fresh chat while retaining your approved account connection.

The caller UI is adapted directly from Cloudflare's [vanilla Pi harness example](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/pi), using its Kumo components, composer, message rendering, and Pi event reducer. Tool details are collapsed and the optional tools sidebar starts closed. This app transports Pi snapshots through cookie-scoped HTTP endpoints rather than exposing the example's generic agent route. The upstream MIT license is in `licenses/cloudflare-agents.txt`.

Northstar is a regular catalog with two product pages and a simple account consent form. Discovery, OAuth metadata, and OpenAPI remain available at their standard endpoints; they are not part of the shopping interface.

## Architecture

```
Browser ── visitor cookie ── Caller Worker / CallerSession (Agent + PiHarness)
                                 │
                    AgentIdentity (durable ES256 key)
                                 │
          Poppy discovery / OAuth / conversations / order API
                                 │
                        Receiving website Worker
                                 │
           ReplayGuard + CompanyUser (SQLite Durable Objects)
```

The caller supplies a hosted Client ID Metadata Document and JWKS. The receiver trusts only this configured peer. Each caller visitor has a random, company-specific opaque user ID, a separate DPoP key, and durable private token storage. Tokens and signing keys do not enter the model transcript or browser state. The Workers communicate through service bindings while signing and validating their public HTTPS request URLs.

## Protocol coverage

- Reciprocal company/issuer discovery, client metadata, ES256 `private_key_jwt` client authentication.
- Signed-out JWT grants with independent client and session assertions, exact audience checks, short expiry, durable JWT replay protection.
- DPoP-bound Session Tokens: method/URL/token-hash checks, key binding, proof replay protection. The caller also handles nonce challenges.
- Direct OAuth authorization-code approval with S256 PKCE, state and issuer validation, exact registered redirects, single-use consent and codes, selected scopes.
- Account Token refresh, session renewal, signed-in new sessions, scope narrowing, and immediate grant revocation across associated sessions.
- Poppy conversations: message-ID retry behavior, opaque cursors, inline events, context, ownership, account pinning, direct child conversations, handoff states, and close behavior.
- An OpenAPI order/exchange API with per-request scope enforcement and a repeatable simulated exchange.

The receiver's company replies are deterministic fixtures. It has no staffed human support desk; handoff truthfully returns to its agent. It uses JSON event responses rather than an SSE stream. Optional mediated auth, device authorization, MCP, A2A, and browser-session exchange are not advertised or implemented. This is a focused interoperability demo, not a complete protocol conformance suite.

`workers-oauth-provider` was considered, but its current API does not supply the draft's required DPoP/session assertion behavior. This demo implements that protocol layer directly using `jose` and Durable Objects.

## Develop with the cf CLI

Requires Node.js 22+ and a Cloudflare account with Workers AI access.

```sh
npm ci
npx cf auth login
npm run dev
```

Caller: http://localhost:8787 · Receiver: http://localhost:8788. Local development uses the real remote Workers AI binding; inference can incur usage. For protocol-only testing, run `npm test`; it uses isolated local workerd instances and needs no Cloudflare login. The cf beta remote AI preview currently returns an opaque connection error in this environment; the deployed caller has been verified with real Pi turns. Local HTTP is explicitly restricted to localhost/127.0.0.1 and is disabled on deployment.

```sh
npm run types
npm run check
npm test
npm run build
npm run smoke:live # verify the deployed synthetic account flow
```

`npm run build` performs `cf deploy --dry-run` for both Workers. Configuration lives in each Worker's `cloudflare.config.ts`; `wrangler.config.ts` supplies local development ports and the caller’s Vite asset build. The small helper handles cf beta's workspace dev-server discovery and keeps its local registry in this project. Binding types are inferred from the canonical configs, with typed Durable Object RPC namespaces.

## Deploy

```sh
POPPY_WORKERS_SUBDOMAIN=your-account.workers.dev npm run deploy
```

The deploy script sets HTTPS origins, disables local HTTP, bootstraps the receiver for the circular service bindings, deploys the caller, then connects the receiver to it. It uses the cf CLI and your existing cf auth profile throughout. Defaults are `poppy-caller` and `poppy-receiver`; set `POPPY_CALLER_NAME` and `POPPY_RECEIVER_NAME` to change them. `POPPY_MODEL` overrides the default `@cf/moonshotai/kimi-k2.7-code` model.

The demo's consent page represents a synthetic account, not a real customer login. A production integration needs real account authentication, a client trust/registration policy, key rotation, bounded data retention, and abuse controls for public inference. PiHarness is a beta API; use the committed lockfile for this demo.

## Files

- `workers/caller/src/session.ts`: Pi tools, client protocol, private visitor state.
- `workers/caller/src/index.ts`: browser API and hosted client metadata/JWKS.
- `workers/caller/client/`: the adapted vanilla Pi chat UI.
- `workers/receiver/src/index.ts`: discovery, OAuth, DPoP and protocol HTTP endpoints.
- `workers/receiver/src/state.ts`: replay and code stores, account grants, conversations.
- `shared/protocol.ts`: JWT, DPoP, validation and bounded body helpers.
- `tests/protocol.test.mjs`: integration tests running the receiver in workerd.
