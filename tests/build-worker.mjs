import { build } from "vite-plus/pack";

/** Bundle the real Worker and its dependencies for an isolated workerd instance. */
export async function buildWorker(side) {
  const result = await build({
    config: false,
    entry: [`workers/${side}/src/index.ts`],
    format: "esm",
    platform: "node",
    target: "es2022",
    write: false,
    dts: false,
    deps: { alwaysBundle: /^(?!cloudflare:)/, neverBundle: /^cloudflare:/ },
    // workerd supplies Node builtins; its in-memory modules have no import.meta.url
    // for Rolldown's eager createRequire polyfill. Keep static builtin imports.
    shims: false,
    outputOptions: { codeSplitting: false, polyfillRequire: false },
    logLevel: "silent",
  });

  try {
    const entry = result.bundles[0].chunks.find((chunk) => chunk.type === "chunk" && chunk.isEntry);

    if (!entry) throw new Error(`Missing bundled entry for ${side}`);

    return entry.code;
  } finally {
    for (const bundle of result.bundles) await bundle[Symbol.asyncDispose]();
  }
}
