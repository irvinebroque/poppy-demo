# Poppy on Cloudflare Workers

A two-Worker demo of the [Personal Agent Protocol draft 0.4](https://personalagentprotocol.org/docs/0.4/spec). The personal agent uses Cloudflare's [PiHarness integration](https://developers.cloudflare.com/changelog/post/2026-10-02-pi-harness/) with Pi Durable, Agents SDK, and Workers AI. Northstar Outfitters is the fictional receiving website.

- **Caller:** https://poppy-caller.roundtrip.workers.dev
- **Receiving website:** https://poppy-receiver.roundtrip.workers.dev

## Try it

1. On the caller, choose **Explore jackets**, then send the prompt. Pi discovers the receiving website, starts a signed-out session, and talks to its agent.
2. Ask to exchange order #1042. Pi requests account access and pauses for you.
3. Choose **Sign in at Northstar** in the conversation. Approve the synthetic account and select its read/write permissions. You return to the same chat.
4. Ask Pi to continue. Review the exchange and choose **Confirm demo exchange**. This simulates an exchange with a $70 difference; no purchase, charge, or shipment occurs.
5. Ask Pi to revoke access whenever you want. **New session** starts a fresh chat while retaining your approved account connection.

The caller UI is adapted directly from Cloudflare's [vanilla Pi harness example](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/pi), using its Kumo components, composer, message rendering, and Pi event reducer. Tool details are collapsed and the optional tools sidebar starts closed. This app projects Pi snapshots into a validated display view through cookie-scoped HTTP endpoints rather than exposing the example's generic agent route. The upstream MIT license is in `licenses/cloudflare-agents.txt`.

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

The caller supplies a hosted Client ID Metadata Document and JWKS. The receiver trusts only this configured peer. When a Poppy session starts, the caller creates a random, company-specific opaque user ID and a separate DPoP key. Token storage remains private and durable. OAuth tokens, Session JWTs, delegations, and signing keys do not enter the model transcript or browser state. The Workers communicate through service bindings while signing and validating their public HTTPS request URLs.

## Protocol coverage

- Poppy 0.4 discovery, described `orders:read` / `orders:write` scopes, and reciprocal OAuth protected resource / issuer metadata (RFC 9728).
- Signed-out requests use only a per-request `Poppy-Session` JWT and `Poppy-Version: 0.4`; there is no signed-out token grant. The caller preserves a stable opaque User ID and chooses each Session ID locally.
- Session JWTs use per-User delegated ES256 keys, with an operator-signed `poppy-delegation+jwt`, a checked thumbprint, request method/URL, audience, token hash, freshness, and durable replay protection. Delegated keys rotate independently of Sessions.
- Direct OAuth authorization-code approval with S256 PKCE, state and issuer validation, exact registered redirects, single-use consent and codes, and selected scopes. Client assertions target the issuer, not the token endpoint.
- Ordinary OAuth access and refresh tokens, independent of Sessions, with DPoP binding, scope narrowing, service-specific conversation tokens, and immediate revocation of associated access tokens. The caller handles DPoP nonce challenges.
- Conversations use request IDs on every POST, `author.type` on messages, `working` / `handoff` / `responder` / `closed` state, opaque cursors and pagination, account pinning, direct child conversations, handoff/cancel, and HTTP 202 close responses.
- An OpenAPI order/exchange API with per-request scope enforcement and a repeatable simulated exchange.

Draft 0.4 is the current **in-progress draft**, not a frozen release. This implementation was checked against [upstream commit `a2ca25a`](https://github.com/personal-agent-protocol/personal-agent-protocol/tree/a2ca25ab43eccc045bc7f2b86d3b579088da9af1/content/versions/0.4) on November 8, 2026. It serves only 0.4, selects a same-origin 0.4 document if a peer advertises it in `supported_versions`, and rejects incompatible versions. Existing 0.1 token grants and conversation state cannot be reused: visitors keep their pairwise User ID but must approve account access again after upgrading.

The receiver's company replies are deterministic fixtures. It has no staffed human support desk; handoff truthfully returns to its agent. It uses JSON event responses rather than an SSE stream. Operations, Mediated Sign-In, device authorization, MCP, and browser-session join are not advertised or implemented. MOLE is optional, as described below. This is a focused interoperability demo, not a complete protocol conformance suite.

This demo implements its OAuth, Session, and conversation layers directly using `jose` and Durable Objects.

## Optional MOLE access

This implements the [MOLE extension version 1](https://github.com/irvinebroque/personal-agent-protocol/blob/proposal/mole-private-access/content/versions/0.4/extensions/mole.mdx) alongside the existing Poppy 0.4 Sessions and OAuth account access. An agent can choose MOLE, an existing Session, or a new anonymous browsing ID. It needs no shortlist approval to start a Session or share task information. Account access keeps the existing OAuth approvals and scopes.

The public checkout runs ordinary Poppy without MOLE. Real MOLE requires access to the pinned internal Guac implementation:

```sh
# Requires internal GitLab SSH access, Rust, wasm-pack and Python 3.10+.
vp run build:guac
vp exec playwright install chromium
vp run test:mole
vp run dev
```

In **Choose how your agent accesses Northstar**, open **Anchor account access** and enter the provisioned invitation. Local development has one account with invitation `northstar-demo-member`. Search spends one of its 24 credits. The Anchor allows one endorsement per registered account per day, independent of visitor cookies and Poppy identifiers. Clearing a cookie or opening a new browser does not create another eligible account. Outside local development, configure the receiver's `MOLE_ANCHOR_ACCOUNTS` secret as a JSON array of `{ "account": "member-id", "token": "a-random-invitation-of-at-least-16-characters" }`. Issue invitations privately; the model never receives them.

**Use Poppy Session** and **Use new anonymous ID** work before or after private search. Pi can also choose `start_session` or `anonymous_session`, and can send search results with `company_message`. **Save shortlist with Poppy** remains an optional convenience for sending selected products. MOLE requests keep omitting Session, account, cookie, and DPoP state even when an ordinary Session exists.

**Lose the next search response** and **Recover search** demonstrate durable credential state and exact-request recovery within 60 seconds without another execution or debit. Starting a new chat preserves the wallet and remaining allowance. Exhaustion, a missing eligible Anchor, or access refusal stops the private operation; choosing another access mode is a separate agent action under its policy and the user's instructions.

### Discovery and providers

With real crypto enabled, `poppy.json` advertises `extensions.mole` version `1` and `moderator_config_uri`, without a resource allowlist. The first API search requests content without identity before discovery. After a MOLE challenge, the caller verifies the Company's discovery document, configuration, Anchor key and epoch before obtaining and presenting a credential. Unknown versions do not establish support. The old `/mole/endpoints` endpoint is gone.

The caller uses the advertised configuration URL, the Moderator's `issuance-uri`, and its configured Anchor's `grant-uri`. It does not infer those URLs from resource challenges. Configuration fetches reject redirects and identifying URL components. Public discovery and all private exchanges use fresh headers; only Anchor requests carry Anchor account authentication.

You can use a hosted provider by setting `POPPY_MOLE_MODERATOR_CONFIG_URI` and `POPPY_MOLE_PROVIDER_ORIGIN` on the receiver and caller. Configure `POPPY_MOLE_ANCHOR_CONFIG_URI` on the caller for an existing Anchor service. `POPPY_MOLE_PROVIDER_NAME` optionally uses a Worker service binding instead of public HTTPS. The demo deliberately restricts destinations to its configured Company and provider origins; it is not an arbitrary-site crawler. Trusted client configuration can supply the Moderator URL when the Company does not advertise MOLE. No usable Anchor match means stop or choose ordinary Poppy access, without automatic enrollment or a central registry.

### Isolated browser demo

```sh
# In another terminal, with vp run dev running:
POPPY_ANCHOR_INVITE=northstar-demo-member vp run browse:private
```

To reuse the web panel’s wallet, click **Copy private browser command** and run that command within 60 seconds instead. The one-use link stays outside model tools and transcripts. This avoids asking the same Anchor account for a second grant.

This opens a new Chromium context at `/private/catalog`. The page, `/private/catalog.css`, and `/private/jacket.svg` each require MOLE and spend one credit. Chromium's Fetch interception handles navigations, redirects and assets through the caller's durable wallet. Every browser network request starts without identifying state; credential proofs and updates remain in the runtime. The context runs offline so an unhandled request cannot reach the network directly. It blocks service workers, page JavaScript, downloads, writes and requests to other origins. This is a read-only browser integration, not a page JavaScript wallet or a shipping browser API.

The launcher keeps its caller visitor cookie in ignored `.private-browser.json` with owner-only permissions, so closing and reopening the isolated context reuses the wallet. No destination cookies, storage, Poppy joins or account state enter the new context. An ordinary browser context remains separate. `/private/redirect` exercises a same-origin redirect; `/private/account` refuses Session-free access; ordinary public product pages remain readable without MOLE. The integration respects `web.disabled` and never signs in or joins the private context automatically. If an asset response loses its credential update, the next browser request resumes the saved GET before spending again, including after a caller restart.

### Validation and limits

`vp run test:mole` exercises real cryptography, durable recovery, independent visitors, account isolation, optional Sessions and sharing, cookie-reset resistance, hosted configuration, missing Anchor matches, unadvertised negotiation, configuration refusal and real Chromium pages/assets/redirects. API-only implementations need no browser integration; the optional browser launcher requires the Chromium installation above. `vp install --frozen-lockfile` never fetches internal source; without crypto, MOLE is unavailable and its integration tests explicitly skip. Disabled adapters cannot issue or accept proofs.

The default Anchor, Moderator, caller and Company share one operator and one accepted Anchor key. They publish a common configuration rather than per-user Anchor sets. Logs, timing, queries and infrastructure can correlate activity. The account policy limits grants; it does not prove humanity or unique personhood. Durable keys and replay records have no automatic key rotation or bounded cleanup in this demo. Production deployments need a key lifecycle and retention policy before retiring replay state. The tests establish compatibility between this implementation's components, not interoperability with an independent MOLE implementation. The demo uses revision 01's EC-IHAT (`0x0002`) and EC-ACT (`0x0001`) flows and HTTP fields; its `METHOD URL` operation binding is application-specific, not an additional Poppy canonicalization rule. See [dependency provenance](vendor/guac/UPSTREAM.md).

## Develop

Use the pinned Node.js 24.22.0 and npm 11.20.0. Install [Vite+](https://viteplus.dev/guide) once, then use the project's pinned Vite+ 1.5.0 toolchain:

```sh
vp install --frozen-lockfile
vp exec cf auth login
vp run dev
```

Caller: http://localhost:8787 · Receiver: http://localhost:8788. `vp run dev` starts both Workers through the Cloudflare `cf` CLI and builds the UI with Vite+. Local development uses the real remote Workers AI binding; inference can incur usage. The protocol tests use isolated local workerd instances and need no Cloudflare login. The replay regression waits 67 seconds with real workerd time.

```sh
vp run types
vp check --deny-warnings
vp test
vp build          # browser assets
vp run build     # assets and cf deploy --dry-run for both Workers
vp run smoke:live # verify the deployed synthetic account flow
```

`npm ci` and the matching `npm run` scripts also work. Use `vp run dev` for the full demo; the built-in `vp dev` serves the browser UI alone.

All build, test, lint, format, and staged-check settings live in the root `vite.config.ts`. Vite+ supplies Vite/Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and TypeScript Go checks. TypeScript strict mode, type-aware linting, React StrictMode, and failure on lint warnings are enabled. `vp check --fix` applies lint fixes and formatting; the installed `.vite-hooks/pre-commit` runs the same strict checks on staged files. CI installs the pinned toolchain with `setup-vp` and runs checks, all tests, both Worker dry runs, and an npm audit.

The complete generic [anti-slop](https://github.com/dmmulroy/anti-slop) ruleset is vendored in `tools/oxlint/anti-slop/` and enforced as errors, alongside `oxc/no-accumulating-spread`. Its source revision, local Vite+ API import adaptation, and licenses are recorded in `tools/oxlint/anti-slop/UPSTREAM.md`. Vendored code and generated output are excluded from linting and formatting. No direct Effect dependency is present, so the opt-in Effect rules are not enabled.

Network JSON, browser commands, OAuth responses, JWT claims, and display snapshots are decoded at their boundaries with Zod. Local HTTP is restricted to localhost/127.0.0.1 and disabled on deployment. Worker configuration lives in each `cloudflare.config.ts`; `wrangler.config.ts` supplies local ports and the caller's Vite+ asset build. The helper handles cf beta's workspace dev-server discovery and keeps its local registry in this project. Binding types are inferred from the canonical configs, with typed Durable Object RPC namespaces.

## Deploy

```sh
POPPY_WORKERS_SUBDOMAIN=your-account.workers.dev vp run deploy
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
- `tests/protocol.test.mjs`: receiver protocol and security regression tests in workerd.
- `tests/caller-flow.test.mjs`: both real Workers, Durable Objects, and service bindings through the complete synthetic account flow.
- `tests/smoke.mjs`: shared assertions used locally and by `vp run smoke:live`; override `POPPY_CALLER_ORIGIN` / `POPPY_RECEIVER_ORIGIN` to test an isolated deployment.
