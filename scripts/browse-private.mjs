import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
import { privateContext } from "./browser/private-context.ts";

const caller = process.env.POPPY_CALLER_ORIGIN ?? "http://localhost:8787";
const receiver = process.env.POPPY_RECEIVER_ORIGIN ?? "http://localhost:8788";
const stateFile = new URL("../.private-browser.json", import.meta.url);
let visitor;

try {
  const state = JSON.parse(await readFile(stateFile, "utf8"));

  if (/^poppy_visitor=[A-Za-z0-9_-]{43}$/.test(state.visitor)) visitor = state.visitor;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

if (process.env.POPPY_BROWSER_TOKEN) {
  const connected = await fetch(caller + "/api/private/browser-connect", {
    method: "POST",
    headers: { Origin: caller, "Content-Type": "application/json" },
    body: JSON.stringify({ browser_token: process.env.POPPY_BROWSER_TOKEN }),
  });

  if (!connected.ok)
    throw new Error(
      "Browser link expired or was already used. Copy a new command from the web panel.",
    );
  visitor = connected.headers.get("Set-Cookie").split(";")[0];
  await writeFile(stateFile, JSON.stringify({ visitor }), { mode: 0o600 });
}

const state = await fetch(caller + "/api/state", { headers: visitor ? { Cookie: visitor } : {} });

if (!state.ok) throw new Error(`Cannot reach caller (${state.status}). Run vp run dev first.`);

if (state.headers.has("Set-Cookie")) {
  visitor = state.headers.get("Set-Cookie").split(";")[0];
  await writeFile(stateFile, JSON.stringify({ visitor }), { mode: 0o600 });
}

if (!visitor) throw new Error("Caller did not establish a wallet session.");

const headers = { Cookie: visitor, Origin: caller, "Content-Type": "application/json" };

if (process.env.POPPY_ANCHOR_INVITE) {
  const signedIn = await fetch(caller + "/api/action", {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "anchor-access", invite: process.env.POPPY_ANCHOR_INVITE }),
  });

  if (!signedIn.ok) throw new Error(`Anchor account setup failed (${signedIn.status}).`);
}

const browser = await chromium.launch({ headless: false });

try {
  const context = await privateContext(browser, receiver, (url) =>
    fetch(caller + "/api/private/resource", {
      method: "POST",
      headers,
      body: JSON.stringify({ url }),
      redirect: "manual",
    }),
  );

  const page = await context.newPage();
  await page.goto(receiver + "/private/catalog");
  console.log(
    "Private browser ready. The caller keeps the wallet across browser restarts. Close the window to finish.",
  );
  await new Promise((resolve) => page.once("close", resolve));
} finally {
  await browser.close();
}
