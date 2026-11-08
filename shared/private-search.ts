import { z } from "zod";
import { idSchema } from "./schemas";

export const searchResultSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  price: z.number().nonnegative(),
  description: z.string(),
  url: z.url(),
});

export type SearchResult = z.infer<typeof searchResultSchema>;

export const searchResponseSchema = z.object({
  results: z.array(searchResultSchema),
  accepted_searches: z.number().int().nonnegative(),
  recovered: z.boolean(),
});

export const privateSearchViewSchema = searchResponseSchema
  .partial({ accepted_searches: true })
  .extend({
    available: z.boolean(),
    balance: z.number().int().nonnegative().nullable(),
    pending: z.boolean(),
    phase: z.enum(["empty", "grant", "endorsement", "issuance", "credential", "presentation"]),
    query: z.string().max(80).optional(),
    shared: z.boolean(),
    exchanges: z.array(
      z.object({ method: z.string(), path: z.string(), status: z.number().int() }),
    ),
  });

export type PrivateSearchView = z.infer<typeof privateSearchViewSchema>;

export const privateSearchStateSchema = z.object({
  private_access: privateSearchViewSchema,
  session_id: idSchema.optional(),
});
