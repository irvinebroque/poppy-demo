# Pinned internal Guac dependency

Source: internal [example-mole-workers](https://gitlab.cfdata.org/cloudflare/crypto/example-mole-workers), branch `thibault/shop-v2`, commit `aa8652de86f70a2485eedbe91316187f4ac4eb15` ([MR 4](https://gitlab.cfdata.org/cloudflare/crypto/example-mole-workers/-/merge_requests/4)).

`Cargo.toml` pins the internal Guac library to `1f86c2990c6e9511fc82e5f7397df32bb0d9a560`. `Cargo.lock` pins its dependencies, including ACT and EC-IHAT. These prototype cryptographic implementations have not been audited. The public repository contains no internal source or generated crypto. `scripts/prepare-guac.mjs` fetches the pinned source into ignored local files; internal source, adapted wallet, Rust lockfile and generated crypto are not published.

Fetched unchanged at build time: the Rust bridge and browser linkage crate, runtime bridge, native declarations, Cargo manifests/lockfile, and Emscripten setup. The build adds Cargo's `--locked` option. The wallet comes from upstream `site/wallet.ts`, with these adaptations:

- A factory owns each caller's mutable platform/configuration state.
- The Worker imports the wasm-bindgen module and calls `initSync`.
- Durable Object storage and a restricted service-binding transport are required; browser IndexedDB, BroadcastChannel, and Web Locks defaults are removed.
- Verified Moderator and Anchor configuration URLs replace `/endpoints`. Issuance and grant URLs come from configuration. The transport restricts destinations to the configured Company and provider origins.
- Browser cookie settings are removed. Workers do not have a browser cookie jar; the transport constructs fresh headers.
- Presentations preserve GET or POST in durable request state for browser pages and assets.
- The adapter preserves protocol errors across the wallet transport so callers can distinguish eligibility refusal and exhausted grants from network failure.

`workers/receiver/src/mole.ts` is a new HTTP/storage adapter, not copied production infrastructure. It uses separate Anchor and Moderator Durable Objects with durable keys rather than upstream's R2 key management and rotation. The Anchor enforces one grant per provisioned account per day. The invitation capability and caller assertion authenticate eligibility only at the Anchor. Account identifiers do not depend on visitor cookies or Poppy IDs; resetting a cookie creates a wallet but cannot replenish that account’s grant. This entitlement policy proves neither humanity nor unique personhood.

Each grant issues 24 client credits, each search spends 1, and exact-request recovery is available for 60 seconds. The Moderator atomically saves the public result, credential recovery record, nullifier tombstone, and execution count. Duplicate requests return that same result. Expired recovery does not authorize another search. This is limited to a read-only synthetic catalog: it is not a general recipe for payments or account writes.

Anchor, Moderator, caller, and site are one operator in this milestone. Shared logs, timing, IP addresses, URLs, and infrastructure can correlate activity. Wallet proofs do not imply network anonymity. The default deployment has no key rotation, bounded replay-store cleanup, separate operator or production log policy. A hosted configuration can use another origin. The model and browser panel invoke the same HTTP wallet. The optional Chromium integration uses an isolated offline context and Fetch interception for navigations, redirects and assets; the wallet and all credentials stay in the caller runtime.

Run `vp run build:guac` with Rust, wasm-pack, Python 3.10+, GitLab SSH access, and Emscripten (or allow the helper to install its pinned SDK). Generated `build/`, `client/`, and `target/` directories are ignored. Keep the source revision and upstream lockfile pinned; do not substitute ad hoc crypto or fabricate proofs.

Fresh public checkouts receive explicit unavailable adapters from `scripts/guac-disabled/`; they throw on every wallet/crypto operation and are never used for the real-crypto suite. `vp run build:guac` replaces them with the pinned implementation. The availability flag is generated locally alongside the dependency; it is not a fabricated wallet or proof.
