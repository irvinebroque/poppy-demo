import { GUAC_AVAILABLE } from "../../../vendor/guac/available";
import { walletStateSchema, type WalletState } from "../../../shared/guac-wallet";
import { createGuacWallet } from "../../../vendor/guac/wallet";
import { claims, fail, id, readText } from "../../../shared/protocol";

import { searchResponseSchema, type PrivateSearchView } from "../../../shared/private-search";

type Wallet = ReturnType<typeof createGuacWallet>;

// One wallet per visitor DO. CallerSession serializes every action, including all
// wallet HTTP and persistence. No proof, credential or eligibility ID enters Pi.
export class PrivateSearch {
  private wallet = createGuacWallet();
  private ready?: ReturnType<Wallet["start"]>;
  constructor(
    private storage: DurableObjectStorage,
    private env: CallerEnv,
  ) {}
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
  private initialize() {
    if (!GUAC_AVAILABLE) fail("private_search_unavailable", 503);

    return (this.ready ??= this.wallet
      .start({
        origin: this.env.RECEIVER_ORIGIN,
        store: {
          get: async () => this.storage.kv.get<WalletState>("mole-wallet"),
          put: async (value) => {
            this.storage.kv.put("mole-wallet", walletStateSchema.parse(value));
            await this.storage.sync();
          },
          lock: (operation) => operation(), // CallerSession owns the surrounding queue.
        },
        fetch: async (address, init) => {
          const url = new URL(address);

          if (url.pathname === "/endpoints") url.pathname = "/mole/endpoints";

          if (
            url.origin !== this.env.RECEIVER_ORIGIN ||
            url.username ||
            url.password ||
            url.hash ||
            ![
              "/mole/endpoints",
              "/mole/anchor/config",
              "/mole/anchor/grant",
              "/mole/moderator/config",
              "/mole/moderator/issue",
              "/private/search",
            ].includes(url.pathname)
          )
            fail("invalid_private_endpoint");
          // Construct fresh headers: visitor cookies and Poppy identity cannot cross.
          const headers = new Headers();

          for (const [name, value] of new Headers(init.headers)) {
            if (!["authorization", "content-type", "x-guac-grant"].includes(name.toLowerCase()))
              fail("invalid_private_header");
            headers.set(name, value);
          }

          if (url.pathname === "/mole/anchor/grant") {
            let owner = this.storage.kv.get<string>("mole-eligibility");

            if (!owner) {
              owner = id("anchor_");
              this.storage.kv.put("mole-eligibility", owner);
            }

            headers.set(
              "Northstar-Eligibility",
              await this.env.IDENTITY.getByName("signing-key").assertion(
                claims(
                  this.env.CALLER_ORIGIN + "/agent.json",
                  owner,
                  this.env.RECEIVER_ORIGIN + "/mole/anchor/grant",
                ),
              ),
            );
          }

          const response = await this.env.RECEIVER.fetch(url.href, {
            method: init.method ?? "GET",
            body: init.body,
            headers,
            redirect: "manual",
            signal: AbortSignal.timeout(30000),
          });

          const view = this.view();
          view.exchanges = [
            ...view.exchanges,
            { method: init.method ?? "GET", path: url.pathname, status: response.status },
          ].slice(-24);
          this.save(view);

          return response;
        },
      })
      .catch((error) => {
        this.ready = undefined;
        throw error;
      }));
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
    if (!query.trim() || query.length > 80) fail("invalid_search");
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
    const view = this.view();
    view.query = query;
    view.results = [];
    view.recovered = false;
    view.shared = false;
    this.save(view);
    const url = new URL("/private/search", this.env.RECEIVER_ORIGIN);
    url.searchParams.set("q", query);

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
