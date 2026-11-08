// Public checkout: no wallet or proofs exist until build:guac installs real Guac.
import type { WalletState } from "../../shared/guac-wallet";

type Platform = {
  moderatorConfig: string;
  anchorConfig: string;
  store: {
    get(): Promise<WalletState | undefined>;
    put(value: WalletState): Promise<void>;
    lock<T>(operation: () => Promise<T>): Promise<T>;
  };
  fetch(address: string, init: RequestInit): Promise<Response>;
};

function unavailable(): never {
  throw new Error("MOLE requires vp run build:guac");
}

export function createGuacWallet() {
  return {
    async start(_platform: Platform): Promise<void> {
      unavailable();
    },
    async read(): Promise<WalletState> {
      return unavailable();
    },
    async obtain(_source: string): Promise<void> {
      unavailable();
    },
    async present(
      _request: { url: string; body: string | null; method?: "GET" | "POST" } | null,
      _options: { discard?: () => boolean; lookup?: boolean },
    ): Promise<
      { kind: "lost" } | { kind: "fresh" | "duplicate" | "recovered"; response: Response }
    > {
      return unavailable();
    },
  };
}
