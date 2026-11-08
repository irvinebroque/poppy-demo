import { z } from "zod";

export const jsonSchema = z.json();

export type JsonValue = z.infer<typeof jsonSchema>;

export const jsonFieldsSchema = z.record(z.string(), jsonSchema);

export type JsonFields = z.infer<typeof jsonFieldsSchema>;

export const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
export const scopeSchema = z.enum(["orders:read", "orders:write"]);

export type Scope = z.infer<typeof scopeSchema>;

export const jwkSchema = z.looseObject({
  kty: z.string(),
  kid: z.string().optional(),
  crv: z.string().optional(),
  x: z.string().optional(),
  y: z.string().optional(),
  d: z.string().optional(),
});

export const clientSchema = z.object({
  client_id: z.string(),
  client_name: z.string(),
  jwks_uri: z.string(),
  redirect_uris: z.array(z.string()),
  token_endpoint_auth_method: z.literal("private_key_jwt"),
});

export const jwksSchema = z.object({ keys: z.array(jwkSchema) });

export const discoverySchema = z.object({
  protocol_version: z.string(),
  supported_versions: z.record(z.string(), z.string()).optional(),
  organization: z.object({ name: z.string(), domain: z.string() }),
  auth: z
    .object({
      issuer: z.string().optional(),
      disabled: z.boolean().optional(),
      scopes: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  agent: z.object({ protocols: z.array(z.object({ type: z.string(), endpoint: z.string() })) }),
  apis: z.array(z.object({ type: z.string(), url: z.string() })),
});

export type Discovery = z.infer<typeof discoverySchema>;

export const metadataSchema = z.object({
  issuer: z.string(),
  protected_resources: z.array(z.string()),
  grant_types_supported: z.array(z.string()),
  token_endpoint: z.string(),
  authorization_endpoint: z.string(),
  revocation_endpoint: z.string(),
  dpop_signing_alg_values_supported: z.array(z.string()),
});

export type Metadata = z.infer<typeof metadataSchema>;

export const resourceSchema = z.object({
  resource: z.string(),
  authorization_servers: z.array(z.string()),
});

export const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal("DPoP"),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
  refresh_token: z.string().min(1).optional(),
});

export const errorSchema = z.object({ error: z.string(), scope: z.string().optional() });

export const messageSchema = z
  .object({
    author: z.object({ type: z.enum(["agent", "human"]) }),
    text: z.string().optional(),
    data: jsonFieldsSchema.optional(),
    context: z
      .object({
        locale: z.string().optional(),
        time_zone: z.string().optional(),
        user_available: z.boolean().optional(),
      })
      .catchall(jsonSchema)
      .optional(),
    extensions: z.record(z.string(), jsonFieldsSchema).optional(),
    as_of_cursor: idSchema.optional(),
  })
  .refine(
    (m) =>
      m.text !== undefined ||
      m.data !== undefined ||
      m.context !== undefined ||
      m.extensions !== undefined,
  )
  .refine((m) => m.as_of_cursor === undefined || m.author.type === "agent");

export type Message = z.infer<typeof messageSchema>;

const eventMessageSchema = messageSchema.safeExtend({
  id: z.string().optional(),
  role: z.string().optional(),
  as_of_request: z.string().optional(),
});

export const eventSchema = z.object({
  id: idSchema,
  type: z.string(),
  created_at: z.string(),
  message: eventMessageSchema.optional(),
  handoff: z.enum(["none", "pending"]).optional(),
  responder: z.enum(["agent", "human"]).optional(),
  closed: z.boolean().optional(),
  error: z.string().optional(),
  scope: z.string().optional(),
  reason: z.string().optional(),
  conversation_id: idSchema.optional(),
});

export type Event = z.infer<typeof eventSchema>;

const responseFields = {
  error: z.string().optional(),
  conversation_id: idSchema.optional(),
  events: z.array(eventSchema).optional(),
  cursor: z.string().optional(),
  has_more: z.boolean().optional(),
  working: z.boolean().optional(),
  handoff: z.enum(["none", "pending"]).optional(),
  closed: z.boolean().optional(),
  responder: z.enum(["agent", "human"]).optional(),
  orders: z
    .array(
      z.object({
        id: z.string(),
        number: z.number(),
        item: z.string(),
        size: z.string(),
        price: z.number(),
        status: z.string(),
      }),
    )
    .optional(),
  exchange_id: z.string().optional(),
  order_id: z.string().optional(),
  replacement_sku: z.string().optional(),
  price_difference: z.number().optional(),
  status: z.string().optional(),
  resource_metadata: z.string().optional(),
};

export const apiResponseSchema = z.object({ ...responseFields, scope: z.string().optional() });

export type ApiResponse = z.infer<typeof apiResponseSchema>;

export const rpcResultSchema = z.object({
  status: z.number().int(),
  body: z.object({
    ...responseFields,
    scope: z.union([z.string(), z.array(z.string())]).optional(),
    account: z.string().optional(),
    access_token: z.string().optional(),
    token_type: z.literal("DPoP").optional(),
    expires_in: z.number().optional(),
    refresh_token: z.string().optional(),
  }),
});

export type RpcResult = z.infer<typeof rpcResultSchema>;

export const actionInputSchema = z.object({
  text: z.string().optional(),
  sender: z.enum(["agent", "human"]).optional(),
  conversation: idSchema.optional(),
  lose_response: z.boolean().optional(),
  product_ids: z.array(idSchema).min(1).max(2).optional(),
});

export type ActionInput = z.infer<typeof actionInputSchema>;

export const actionSchema = actionInputSchema.extend({ action: z.string() });

export const promptSchema = z.object({
  prompt: z.string().min(1).max(8000),
  operation_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  when_busy: z.enum(["followUp", "steer"]).optional(),
});

export const conversationRequestSchema = z
  .object({
    id: idSchema,
    message: messageSchema.optional(),
    parent_conversation_id: idSchema.optional(),
    user_requested_event_id: idSchema.optional(),
  })
  .catchall(jsonSchema)
  .refine((b) => b.user_requested_event_id === undefined || b.parent_conversation_id !== undefined);
