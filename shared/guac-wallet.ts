import { z } from "zod";

const bytes = z.instanceof(Uint8Array);
const source = z.enum(["sso", "nocheck", "turnstile"]);

// The locally fetched wallet validates this state too. Parse again where its
// storage callback enters our durable store, so our persistence has a contract.
export const walletStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("empty") }),
  z.object({ kind: z.literal("grant"), source, bytes, request: bytes, id: z.string().nullable() }),
  z.object({ kind: z.literal("endorsement"), source, bytes, key: bytes, epoch: bytes }),
  z.object({ kind: z.literal("issuance"), bytes, authorization: z.string() }),
  z.object({ kind: z.literal("credential"), bytes, balance: z.string().regex(/^\d+$/) }),
  z.object({
    kind: z.literal("presentation"),
    bytes,
    authorization: z.string(),
    target: z.object({
      url: z.url(),
      body: z.string().nullable(),
      method: z.enum(["GET", "POST"]).optional(),
    }),
  }),
]);

export type WalletState = z.infer<typeof walletStateSchema>;
