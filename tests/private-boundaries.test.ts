import { test, expect } from "vite-plus/test";
import { actionSchema } from "../shared/schemas";
import { searchResponseSchema, privateSearchStateSchema } from "../shared/private-search";
import { walletStateSchema } from "../shared/guac-wallet";

test("private browser commands preserve validated options", () => {
  const search = { action: "private-search", text: "warm jacket", lose_response: true };
  const share = { action: "remember-shortlist", product_ids: ["stormline-insulated"] };
  expect(actionSchema.parse(search)).toEqual(search);
  expect(actionSchema.parse(share)).toEqual(share);

  for (const command of [
    { action: "private-search", text: 42 },
    { action: "private-search", lose_response: "yes" },
    { action: "remember-shortlist", product_ids: "stormline-insulated" },
    { action: "remember-shortlist", product_ids: [42] },
    { action: "remember-shortlist", product_ids: [] },
  ])
    expect(actionSchema.safeParse(command).success).toBe(false);
});

test("private results and browser state reject malformed wire values", () => {
  const product = {
    id: "stormline-insulated",
    name: "Jacket",
    price: 250,
    description: "Insulated",
    url: "https://store.test/products/stormline-insulated",
  };

  const result = { results: [product], accepted_searches: 1, recovered: false };
  expect(searchResponseSchema.parse(result)).toEqual(result);

  for (const value of [
    { ...result, accepted_searches: -1 },
    { ...result, accepted_searches: "1" },
    { ...result, recovered: "yes" },
    { ...result, results: [{ ...product, price: null }] },
    { ...result, results: [{ ...product, url: "invalid" }] },
  ])
    expect(searchResponseSchema.safeParse(value).success).toBe(false);

  const view = {
    ...result,
    available: true,
    balance: 23,
    phase: "credential",
    pending: false,
    shared: false,
    exchanges: [],
  };

  expect(privateSearchStateSchema.safeParse({ private_access: view }).success).toBe(true);
  expect(
    privateSearchStateSchema.safeParse({ private_access: { ...view, pending: "false" } }).success,
  ).toBe(false);
  expect(
    privateSearchStateSchema.safeParse({ private_access: { ...view, balance: -1 } }).success,
  ).toBe(false);
});

test("durable wallet writes require a complete continuation and binary state", () => {
  const pending = {
    kind: "presentation",
    bytes: new Uint8Array([1, 2]),
    authorization: "Mole test",
    target: { url: "https://store.test/private/search?q=jacket", body: null },
  };

  expect(walletStateSchema.parse(pending)).toEqual(pending);
  expect(walletStateSchema.safeParse({ ...pending, target: undefined }).success).toBe(false);
  expect(walletStateSchema.safeParse({ ...pending, bytes: [1, 2] }).success).toBe(false);
  expect(
    walletStateSchema.safeParse({ kind: "credential", bytes: new Uint8Array([1]), balance: "-1" })
      .success,
  ).toBe(false);
});
