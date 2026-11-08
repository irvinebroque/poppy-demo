import { readFile } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { build } from "vite-plus/pack";

/** Bundle the real Worker and its dependencies for an isolated workerd instance. */
export async function buildWorker(side) {
  return buildWorkerManifest(`workers/${side}/src/index.ts`);
}

export async function buildWorkerManifest(entryPoint) {
  const modules = {};

  const result = await build({
    config: false,
    entry: [entryPoint],
    plugins: [
      {
        name: "worker-wasm",
        async resolveId(source, importer) {
          if (!source.endsWith(".wasm") || !importer) return;
          const path = resolve(dirname(importer), source);
          const name = basename(path);
          modules[name] = { type: "wasm", contents: await readFile(path) };

          return { id: "./" + name, external: true };
        },
      },
    ],
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

    if (!entry) throw new Error(`Missing bundled entry for ${entryPoint}`);

    modules["index.mjs"] = { type: "esm", contents: entry.code };

    return { mainModule: "index.mjs", modules };
  } finally {
    for (const bundle of result.bundles) await bundle[Symbol.asyncDispose]();
  }
}
