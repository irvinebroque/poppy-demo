import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, copyFile, access } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const revision = "aa8652de86f70a2485eedbe91316187f4ac4eb15";
const repository = "ssh://git@gitlab.cfdata.org/cloudflare/crypto/example-mole-workers.git";
const destination = resolve(root, "vendor/guac");

const files = [
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  ".cargo/config.toml",
  "build.mjs",
  "emsdk.mjs",
  "runtime.ts",
  "native.d.ts",
  "browser/Cargo.toml",
  "browser/src/lib.rs",
  "crypto/Cargo.toml",
  "crypto/src/lib.rs",
  "crypto/src/main.rs",
];

function replace(source, pattern, replacement) {
  if (!pattern.test(source))
    throw new Error(`Pinned Guac source does not match adapter: ${pattern}`);

  return source.replace(pattern, replacement);
}

// Adapt the fetched wallet locally. No upstream implementation or generated
// crypto is redistributed by this public repository.
function wallet(source) {
  source = replace(
    source,
    /^let channel:[\s\S]*?(?=^export async function read\()/m,
    "let platform: Platform;\n\n",
  );
  source = replace(source, /import init, \{/, "import { initSync,");
  source = replace(source, /\.\/wasm\/guac\.js/, "./client/guac.js");
  source = replace(source, /origin = location\.origin/, "origin = ''");
  source = replace(
    source,
    /  if \(!navigator\.locks\)[\s\S]*?(?=  await platform\.store\.get\(\);)/,
    "  if (!replaced.store) throw new Error('A durable caller wallet store is required.');\n" +
      "  if (!replaced.fetch) throw new Error('A private transport is required.');\n" +
      "  platform = { store: replaced.store, fetch: replaced.fetch };\n  initSync({ module: clientModule });\n",
  );
  source = replace(
    source,
    /^    if \(url\.origin !== address.*$/m,
    "    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))))",
  );
  // The Poppy adapter supplies verified configuration URLs. No demo endpoint
  // discovery or inferred /config, /issue or /grant URL crosses the transport.
  source = replace(
    source,
    /let endpoints: Endpoints \| undefined;/,
    "let endpoints: Endpoints | undefined;\nlet issuance = '';\nlet grant = '';",
  );
  source = replace(
    source,
    /function endpoint\(role: keyof Endpoints, path: string\) \{[\s\S]*?\n\}/,
    "function endpoint(role: keyof Endpoints, path: string) {\n" +
      "  if (!endpoints) throw new Error('Endpoints not loaded.');\n" +
      "  const address = path === '/config' ? endpoints[role] : role === 'moderator' ? issuance : grant;\n" +
      "  if (!address) throw new Error('Verified endpoint unavailable.');\n  return address;\n}",
  );
  source = replace(
    source,
    /origin = '', wasm, \.\.\.replaced/,
    "moderatorConfig = '', anchorConfig = '', wasm, ...replaced",
  );
  source = replace(
    source,
    /origin\?: string; wasm\?: BufferSource/,
    "moderatorConfig?: string; anchorConfig?: string; wasm?: BufferSource",
  );
  source = replace(
    source,
    /  const response = await platform\.fetch\(`\$\{origin\}\/endpoints`[\s\S]*?return \{ endpoints, sitekey: value\.sitekey \};/,
    "  if (!moderatorConfig || !anchorConfig) throw new Error('Verified configuration URLs required.');\n" +
      "  endpoints = { moderator: moderatorConfig, sso: anchorConfig, nocheck: anchorConfig, turnstile: anchorConfig };\n" +
      "  return { endpoints, sitekey: '' };",
  );
  source = replace(
    source,
    /  hooks\.config\('moderator', value\);/,
    "  issuance = uri;\n  hooks.config('moderator', value);",
  );
  source = replace(
    source,
    /  hooks\.config\(which, value\);/,
    "  if (!object(value) || typeof value['grant-uri'] !== 'string') throw new Error('Missing grant URI.');\n" +
      "  grant = value['grant-uri'];\n  hooks.config(which, value);",
  );
  source = replace(
    source,
    /type Target = \{ url: string; body: string \| null \};/,
    "type Target = { url: string; body: string | null; method?: 'GET' | 'POST' };",
  );
  source = replace(
    source,
    /return object\(value\) && typeof value\.url/,
    "return object(value) && (value.method === undefined || value.method === 'GET' || value.method === 'POST') && typeof value.url",
  );
  source = replace(
    source,
    /target: \{ url: value\.target\.url, body: value\.target\.body \}/,
    "target: { url: value.target.url, body: value.target.body, method: value.target.method }",
  );
  source = replace(
    source,
    /body: string \| null, step: Step\) \{/,
    "body: string | null, step: Step, method = 'POST') {",
  );
  source = replace(
    source,
    /fetchAs\(name, url, \{ method: 'POST', body \}, step\)/,
    "fetchAs(name, url, { method, body }, step)",
  );
  source = replace(
    source,
    /fresh\.body, 'presentation-challenge'\)/,
    "fresh.body, 'presentation-challenge', fresh.method ?? 'POST')",
  );
  source = replace(
    source,
    /method: 'POST', body: current\.target\.body/,
    "method: current.target.method ?? 'POST', body: current.target.body",
  );
  source = replace(
    source,
    /  catch \{\n    if \(step\) trace/,
    "  catch (error) {\n    if (error instanceof ProtocolError) throw error;\n    if (step) trace",
  );
  source = source.replace(/credentials: 'include', /g, "").replace(/^export /gm, "");
  source = replace(
    source,
    /(from '\.\/client\/guac\.js';)/,
    "$1\nimport clientModule from './client/guac_bg.wasm';\nexport function createGuacWallet() {",
  );

  return (
    "// Generated locally from pinned internal Guac; see UPSTREAM.md.\n" +
    "import { ProtocolError } from '../../shared/protocol';\n" +
    source +
    "\nreturn { start, read, save, locked, obtain, present, hooks, CREDITS };\n}\n"
  );
}

export async function prepareGuac() {
  const supplied = process.env.GUAC_SOURCE_DIR;
  const source = supplied ? resolve(supplied) : resolve(root, "vendor/.guac-source");

  if (!supplied) {
    await mkdir(source, { recursive: true });
    execFileSync("git", ["init", "--quiet", source]);
    execFileSync("git", ["-C", source, "fetch", "--quiet", "--depth=1", repository, revision], {
      stdio: "inherit",
    });
  }

  const content = (path) =>
    execFileSync("git", ["-C", source, "show", `${revision}:${path}`], {
      maxBuffer: 4 * 1024 * 1024,
    });

  for (const path of files) {
    const target = resolve(destination, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content(path));
  }

  const buildPath = resolve(destination, "build.mjs");
  await writeFile(
    buildPath,
    replace(await readFile(buildPath, "utf8"), /\['rustc',/, "['rustc', '--locked',"),
  );
  await writeFile(
    resolve(destination, "wallet.ts"),
    wallet(content("site/wallet.ts").toString("utf8")),
  );
  await writeFile(resolve(destination, "available.ts"), "export const GUAC_AVAILABLE = true;\n");
  console.log(`Prepared internal Guac ${revision.slice(0, 12)} in ignored vendor/guac/`);
}

export async function guacAvailable() {
  try {
    const wallet = await readFile(resolve(destination, "available.ts"), "utf8");

    if (!wallet.includes("GUAC_AVAILABLE = true")) return false;
    await Promise.all(
      ["client/guac_bg.wasm", "build/crypto.wasm"].map((path) =>
        access(resolve(destination, path)),
      ),
    );

    return true;
  } catch {
    return false;
  }
}

// npm ci never fetches private source. A missing dependency disables MOLE;
// it cannot produce a credential, proof, or successful private search.
async function optionalGuac() {
  if (await guacAvailable()) return;
  await mkdir(destination, { recursive: true });
  await writeFile(resolve(destination, "available.ts"), "export const GUAC_AVAILABLE = false;\n");

  for (const name of ["wallet.ts", "runtime.ts"])
    await copyFile(resolve(root, "scripts/guac-disabled", name), resolve(destination, name));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--optional")) await optionalGuac();
  else if (process.argv.includes("--require")) {
    if (!(await guacAvailable()))
      throw new Error(
        "Real Guac is unavailable: run vp run build:guac with internal GitLab access first.",
      );
  } else await prepareGuac();
}
