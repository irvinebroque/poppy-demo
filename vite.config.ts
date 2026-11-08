import { defineConfig, lazyPlugins } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

const ignorePatterns = [
  ".agent/**",
  ".agents/**",
  ".claude/**",
  ".codex/**",
  ".continue/**",
  ".cursor/**",
  ".gemini/**",
  ".opencode/**",
  ".pi/**",
  ".roo/**",
  ".windsurf/**",
  "tools/oxlint/anti-slop/**",
  "workers/caller/public/**",
  "**/.cloudflare/**",
  "**/.wrangler/**",
];

export default defineConfig({
  root: fileURLToPath(new URL("./workers/caller/client", import.meta.url)),
  plugins: lazyPlugins(() => [react(), tailwindcss()]),
  build: {
    outDir: "../public",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1100,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "validation", test: /[/\\]node_modules[/\\]zod[/\\]/ },
            { name: "react", test: /[/\\]node_modules[/\\](react|react-dom|scheduler)[/\\]/ },
          ],
        },
      },
    },
  },
  staged: { "*": "vp check --fix --deny-warnings" },
  fmt: { ignorePatterns },
  lint: {
    ignorePatterns,
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    ],
    plugins: ["typescript", "unicorn", "oxc", "react", "jsx-a11y"],
    rules: {
      "anti-slop/no-array-filter-map": "error",
      "anti-slop/no-reduce-accumulator-copy": "error",
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-conditional-empty-object-spread": "error",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-runtime-typeof": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-shape-in-symbol-names": "error",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-readable-spacing": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
      "oxc/no-accumulating-spread": "error",
      "vite-plus/prefer-vite-plus-imports": "error",
      "typescript/no-floating-promises": "error",
      "typescript/no-explicit-any": "error",
    },
    options: { typeAware: true, typeCheck: true, denyWarnings: true },
  },
  test: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["tests/**/*.test.mjs", "tests/**/*.test.ts"],
    testTimeout: 90_000,
    hookTimeout: 30_000,
    sequence: { concurrent: false },
  },
});
