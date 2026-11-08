# Pinned internal Guac dependency

Source: internal [example-mole-workers](https://gitlab.cfdata.org/cloudflare/crypto/example-mole-workers), branch `thibault/shop-v2`, commit `aa8652de86f70a2485eedbe91316187f4ac4eb15` ([MR 4](https://gitlab.cfdata.org/cloudflare/crypto/example-mole-workers/-/merge_requests/4)).

`Cargo.toml` pins the internal Guac library to `1f86c2990c6e9511fc82e5f7397df32bb0d9a560`. `Cargo.lock` pins its dependencies, including ACT and EC-IHAT. These prototype cryptographic implementations have not been audited. The public repository contains no internal source or generated crypto. `scripts/prepare-guac.mjs` fetches the pinned source into ignored local files; internal source, adapted wallet, Rust lockfile and generated crypto are not published.

Fetched unchanged at build time: the Rust bridge and browser linkage crate, runtime bridge, native declarations, Cargo manifests/lockfile, and Emscripten setup. The build adds Cargo's `--locked` option. The wallet comes from upstream `site/wallet.ts`, with these adaptations:

- A factory owns each caller's mutable platform/configuration state.
- The Worker imports the wasm-bindgen module and calls `initSync`.
- Durable Object storage and a restricted service-binding transport are required; browser IndexedDB, BroadcastChannel, and Web Locks defaults are removed.
- Endpoint base paths are allowed. The transport separately restricts every destination to the configured receiver and six explicit routes.
- Browser cookie settings are removed. Workers do not have a browser cookie jar; the transport constructs fresh headers.

`workers/receiver/src/mole.ts` is a new HTTP/storage adapter, not copied production infrastructure. It uses separate Anchor and Moderator Durable Objects with durable keys rather than upstream's R2 key management and rotation. The Anchor enforces one synthetic grant per opaque caller-wallet ID per day; resetting the visitor cookie can create another wallet. It proves neither humanity nor unique personhood. Anchor eligibility is a short signed assertion from the registered caller. Its subject is independent of the lazily created Poppy user and is sent only to the Anchor.

Each grant issues 24 client credits, each search spends 1, and exact-request recovery is available for 60 seconds. The Moderator atomically saves the public result, credential recovery record, nullifier tombstone, and execution count. Duplicate requests return that same result. Expired recovery does not authorize another search. This is limited to a read-only synthetic catalog: it is not a general recipe for payments or account writes.

Anchor, Moderator, caller, and site are one operator in this milestone. Shared logs, timing, IP addresses, URLs, and infrastructure can correlate activity. Wallet proofs do not imply network anonymity. There is no key rotation, separate operator deployment, production log policy, native-browser wallet, or browser credential injection in this milestone. The model can invoke the HTTP wallet through a private tool; the browser panel uses that same caller wallet.

Run `vp run build:guac` with Rust, wasm-pack, Python 3.10+, GitLab SSH access, and Emscripten (or allow the helper to install its pinned SDK). Generated `build/`, `client/`, and `target/` directories are ignored. Keep the source revision and upstream lockfile pinned; do not substitute ad hoc crypto or fabricate proofs.

Fresh public checkouts receive explicit unavailable adapters from `scripts/guac-disabled/`; they throw on every wallet/crypto operation and are never used for the real-crypto suite. `vp run build:guac` replaces them with the pinned implementation. The availability flag is generated locally alongside the dependency; it is not a fabricated wallet or proof.
