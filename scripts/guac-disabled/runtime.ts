// Disabled build contract for our adapter. Every cryptographic operation fails.
type Reply =
  | { kind: "failed"; status: number }
  | { kind: "header"; value: string }
  | { kind: "message"; bytes: number[] }
  | { kind: "operation"; operation: "none" | "issue" | "presentation" | "recovery" }
  | { kind: "nullifier"; nullifier: number[] }
  | { kind: "issued"; replay_id: number[] | null; epoch: number[] | null; credential: string }
  | { kind: "verified"; record: number[]; credential: string }
  | { kind: "anchor_committed"; state: number[]; response: number[]; expires_at: number };

export type Crypto = {
  configuration: {
    endpoint: string;
    public_key: number[];
    context: number[];
    balance_bits: number;
    retention: string;
  };
  run(command: Command): Reply;
};

function unavailable(): never {
  throw new Error("MOLE requires vp run build:guac");
}

export function base64url(_bytes: number[]): string {
  return unavailable();
}

export async function generateSecret(_role: "anchor" | "moderator"): Promise<string> {
  return unavailable();
}

export async function createAnchorCrypto(
  _secret: string,
  _epoch: number[],
): Promise<{ configuration: { public_key: number[]; epoch: number[] }; run: Crypto["run"] }> {
  return unavailable();
}

export async function createCrypto(
  _secret: string,
  _endpoint: string,
  _context: string,
  _anchors: { keys: number[][]; epoch: number[] } | null,
  _previous: null,
): Promise<Crypto> {
  return unavailable();
}

type Price = { cost: number; allowance: number; refund: number };

type Command =
  | { kind: "operation" | "nullifier"; authorization: string }
  | { kind: "recover"; now: number; authorization: string; record: number[] }
  | { kind: "issuance_challenge" | "anchor_commit"; now: number }
  | { kind: "issue"; now: number; authorization: string }
  | { kind: "presentation_challenge"; now: number; binding: string; price: Price }
  | { kind: "verify"; now: number; authorization: string; binding: string; price: Price }
  | { kind: "anchor_respond"; now: number; state: number[]; request: number[] };
