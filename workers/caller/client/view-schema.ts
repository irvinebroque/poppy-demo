import { z } from "zod";
import { jsonSchema } from "../../../shared/schemas";

const contentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
]);

const partSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
  z.object({ type: z.literal("thinking"), text: z.string() }),
  z.object({
    type: z.literal("tool-call"),
    id: z.string(),
    name: z.string(),
    arguments: jsonSchema,
  }),
  z.object({
    type: z.literal("tool-result"),
    id: z.string(),
    name: z.string(),
    content: z.array(contentSchema),
    details: jsonSchema.optional(),
    error: z.boolean(),
  }),
]);

const transcriptMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "tool", "notice"]),
  parts: z.array(partSchema),
  timestamp: z.number(),
  stopReason: z.string().optional(),
  error: z.string().optional(),
});

export const viewSchema = z.object({
  messages: z.array(transcriptMessageSchema),
  live: transcriptMessageSchema.nullable(),
  running: z.boolean(),
  tools: z.array(z.object({ callId: z.string(), name: z.string(), output: z.string() })),
  queued: z.number(),
  retry: z.object({ at: z.number(), error: z.string() }).nullable(),
  model: z.object({ provider: z.string(), modelId: z.string() }).nullable(),
  error: z.string().nullable(),
});

export const snapshotSchema = z.object({
  session: z.string(),
  view: viewSchema,
  tools: z.array(z.object({ name: z.string(), description: z.string() })),
  approval: z.object({ sign_in_url: z.string().optional(), exchange_proposed: z.boolean() }),
});
