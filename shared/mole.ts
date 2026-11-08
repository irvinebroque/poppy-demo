import { z } from "zod";

export const moleDiscoverySchema = z.object({
  auth: z.object({ issuer: z.string().optional() }).optional(),
  organization: z.object({ domain: z.string() }),
  web: z.object({ disabled: z.boolean().optional() }).optional(),
  extensions: z
    .object({
      mole: z
        .array(z.object({ version: z.string(), moderator_config_uri: z.string().optional() }))
        .optional(),
    })
    .optional(),
});

export const moderatorConfigSchema = z.object({
  "issuance-uri": z.url(),
  endorsements: z.array(
    z.object({
      "endorsement-type": z.number(),
      ciphersuite: z.string(),
      "anchor-set": z.array(z.string()),
      "issuance-epoch": z.string(),
    }),
  ),
  "credential-keys": z.array(
    z.object({
      "credential-type": z.number(),
      ciphersuite: z.string(),
      "credential-key": z.string(),
      "balance-width": z.number().int(),
      "credential-context": z.string(),
      "result-retention": z.number().int().nonnegative(),
    }),
  ),
});

export const anchorConfigSchema = z.object({
  "grant-uri": z.url(),
  "endorsement-type": z.literal(2),
  ciphersuite: z.literal("P256-SHA256"),
  "anchor-key": z.string(),
  "issuance-epoch": z.string(),
});

export const privateResourceSchema = z.object({ url: z.url() });

export const anchorAccountsSchema = z
  .array(
    z.object({
      account: z.string().min(1),
      token: z.string().min(16),
    }),
  )
  .min(1);

export const browserLinkSchema = z.object({ browser_token: z.string().min(1).max(8192) });
