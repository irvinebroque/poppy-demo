import { GUAC_AVAILABLE } from "../../../vendor/guac/available";
import { walletStateSchema, type WalletState } from "../../../shared/guac-wallet";
import { createGuacWallet } from "../../../vendor/guac/wallet";
import { fail, readText } from "../../../shared/protocol";

import { searchResponseSchema, type PrivateSearchView } from "../../../shared/private-search";

import { MoleTransport } from "./mole-transport";

type Wallet = ReturnType<typeof createGuacWallet>;

// One wallet per visitor DO. CallerSession serializes every action, including all
// wallet HTTP and persistence. No proof, credential or eligibility ID enters Pi.
export class PrivateSearch {
  private wallet = createGuacWallet();
  private transport: MoleTransport;
  private ready?: ReturnType<Wallet["start"]>;
  constructor(
    private storage: DurableObjectStorage,
    private env: CallerEnv,
  ) {
    this.transport = new MoleTransport(storage, env);
  }
  view(): PrivateSearchView {
    return {
      ...(this.storage.kv.get<PrivateSearchView>("private-view") ?? {
        balance: null,
        pending: false,
        phase: "empty",
        results: [],
        recovered: false,
        shared: false,
        exchanges: [],
      }),
      available: GUAC_AVAILABLE,
    };
  }
  private save(view: PrivateSearchView) {
    this.storage.kv.put("private-view", view);
  }
  authenticate(invite: string) {
    this.storage.kv.put("anchor-invite", invite);
  }
  private async initialize() {
    if (!GUAC_AVAILABLE) fail("private_search_unavailable", 503);

    if (!this.ready) {
      const configuration = await this.transport.configuration();
      this.ready = this.wallet
        .start({
          ...configuration,
          store: {
            get: async () => this.storage.kv.get<WalletState>("mole-wallet"),
            put: async (value) => {
              this.storage.kv.put("mole-wallet", walletStateSchema.parse(value));
              await this.storage.sync();
            },
            lock: (operation) => operation(),
          },
          fetch: async (address, init) => {
            const response = await this.transport.request(address, init);
            const view = this.view();
            view.exchanges = [
              ...view.exchanges,
              {
                method: init.method ?? "GET",
                path: new URL(address).pathname,
                status: response.status,
              },
            ].slice(-24);
            this.save(view);

            return response;
          },
        })
        .catch((error) => {
          this.ready = undefined;
          throw error;
        });
    }

    return this.ready;
  }
  private async obtain() {
    await this.initialize();
    let state = await this.wallet.read();

    if (state.kind === "presentation") fail("recover_search_first", 409);

    for (let step = 0; step < 3 && state.kind !== "credential"; step++) {
      if ("bytes" in state) state.bytes.fill(0);
      await this.wallet.obtain("nocheck");
      state = await this.wallet.read();
    }

    if (state.kind !== "credential") fail("credential_unavailable");
    const balance = Number(state.balance);
    state.bytes.fill(0);

    if (balance < 1) fail("private_allowance_exhausted", 429);
  }
  async resource(raw: string) {
    const target = new URL(raw);

    if (
      target.origin !== this.env.RECEIVER_ORIGIN ||
      target.username ||
      target.password ||
      target.hash
    )
      fail("invalid_private_endpoint");

    if (
      ["/oauth/", "/poppy/", "/api/orders", "/mole/"].some((prefix) =>
        target.pathname.startsWith(prefix),
      )
    )
      fail("private_resource_not_supported", 403);
    await this.transport.checkBrowsing();
    const pending = this.storage.kv.get<WalletState>("mole-wallet");

    if (pending?.kind === "presentation") {
      if (pending.target.method !== "GET") fail("recover_search_first", 409);
      await this.initialize();
      const recovered = await this.presentResource(null);

      if (pending.target.url === target.href) return recovered;
      await recovered.body?.cancel();
    }

    const response = await this.transport.request(target.href);

    if (response.status !== 401 || !response.headers.get("WWW-Authenticate")?.startsWith("Mole "))
      return response;
    await response.body?.cancel();
    await this.obtain();

    return this.presentResource(target.href);
  }
  private async presentResource(url: string | null) {
    try {
      const presented = await this.wallet.present(url ? { url, body: null, method: "GET" } : null, {
        lookup: false,
      });

      if (presented.kind === "lost") fail("private_response_lost", 409);
      const headers = new Headers(presented.response.headers);
      headers.delete("Mole-Credential");
      headers.delete("Set-Cookie");

      return new Response(presented.response.body, {
        status: presented.response.status === 409 ? 200 : presented.response.status,
        headers,
      });
    } finally {
      await this.update();
    }
  }
  private async update() {
    const state = await this.wallet.read(),
      view = this.view();

    view.phase = state.kind;
    view.pending = state.kind === "presentation";
    view.balance = state.kind === "credential" ? Number(state.balance) : null;

    if ("bytes" in state) state.bytes.fill(0);
    this.save(view);

    return view;
  }
  async search(query: string, loseResponse = false) {
    if (!GUAC_AVAILABLE) fail("private_search_unavailable", 503);

    if (!query.trim() || query.length > 80) fail("invalid_search");

    if (this.view().pending) fail("recover_search_first", 409);
    const url = new URL("/private/search", this.env.RECEIVER_ORIGIN);
    url.searchParams.set("q", query);
    // The first request discloses no identity, even before discovery or a grant.
    const initial = await this.transport.request(url.href, { method: "POST" });

    if (initial.status !== 401 || !initial.headers.get("WWW-Authenticate")?.startsWith("Mole ")) {
      if (!initial.ok) fail("private_access_refused", initial.status);
      await this.complete({ kind: "fresh", response: initial });

      return this.view();
    }

    await initial.body?.cancel();
    await this.obtain();
    const view = this.view();
    view.query = query;
    view.results = [];
    view.recovered = false;
    view.shared = false;
    this.save(view);

    try {
      await this.complete(
        await this.wallet.present({ url: url.href, body: null }, { discard: () => loseResponse }),
      );
    } finally {
      await this.update();
    }

    return this.view();
  }
  async recover() {
    await this.initialize();

    if ((await this.wallet.read()).kind !== "presentation") fail("no_pending_search");

    try {
      await this.complete(await this.wallet.present(null, { lookup: false }));
    } finally {
      await this.update();
    }

    return this.view();
  }
  private async complete(presented: Awaited<ReturnType<Wallet["present"]>>) {
    if (presented.kind === "lost") return this.view();

    if (![200, 409].includes(presented.response.status))
      fail("private_search_failed", presented.response.status);
    const parsed = searchResponseSchema.safeParse(JSON.parse(await readText(presented.response)));

    if (!parsed.success) fail("invalid_search_response");
    const found = parsed.data;
    const view = { ...this.view(), ...found };
    this.save(view);

    return view;
  }
  markShared() {
    const view = this.view();
    view.shared = true;
    this.save(view);
  }
}
