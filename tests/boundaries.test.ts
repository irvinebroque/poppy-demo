import { test, expect } from "vite-plus/test";
import { z } from "zod";
import { bodyJson, json, ProtocolError } from "../shared/protocol";
import { messageSchema, tokenSchema } from "../shared/schemas";
import { snapshotSchema } from "../workers/caller/client/view-schema";

test.each([new Headers({ "X-Test": "value" }), [["X-Test", "value"]], { "X-Test": "value" }])(
  "JSON responses preserve every HeadersInit representation",
  (headers) => {
    const response = json({ ok: true }, 202, headers);
    expect(response.status).toBe(202);
    expect(response.headers.get("X-Test")).toBe("value");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(
      json({}, 200, new Headers({ "Cache-Control": "public, max-age=300" })).headers.get(
        "Cache-Control",
      ),
    ).toBe("public, max-age=300");
  },
);

test("body decoding rejects malformed, oversized, and schema-invalid requests", async () => {
  const schema = z.object({ text: z.string() });

  for (const body of [
    "{",
    "null",
    "[]",
    '{"text":{}}',
    JSON.stringify({ text: "a".repeat(65536) }),
  ]) {
    await expect(
      bodyJson(new Request("https://test.invalid", { method: "POST", body }), schema),
    ).rejects.toBeInstanceOf(ProtocolError);
  }

  await expect(
    bodyJson(
      new Request("https://test.invalid", { method: "POST", body: '{"text":"hello"}' }),
      schema,
    ),
  ).resolves.toEqual({ text: "hello" });
});

test("wire schemas reject invalid message context, token lifetimes, and display snapshots", () => {
  expect(
    messageSchema.safeParse({ author: { type: "agent" }, context: { user_available: "yes" } })
      .success,
  ).toBe(false);
  expect(
    messageSchema.safeParse({ author: { type: "human" }, text: "hello", as_of_cursor: "evt_1" })
      .success,
  ).toBe(false);
  expect(
    tokenSchema.safeParse({ access_token: "secret", token_type: "DPoP", expires_in: "3600" })
      .success,
  ).toBe(false);
  expect(
    tokenSchema.safeParse({ access_token: "secret", token_type: "DPoP", expires_in: -1 }).success,
  ).toBe(false);
  expect(
    snapshotSchema.safeParse({
      session: "session",
      view: {},
      tools: [],
      approval: { exchange_proposed: false },
    }).success,
  ).toBe(false);
});
