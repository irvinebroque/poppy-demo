# Development

Use the Cloudflare CLI (`cf`) for Worker development, deployment, and resource management. Consult https://developers.cloudflare.com/cf/get-started/ and use `cf cli search` or command help to discover supported commands.

Use the pinned Node.js, npm, and Vite+ versions. Install with `vp install --frozen-lockfile`. Use `vp run dev` to run both Workers, `vp build` for the UI, and `vp run build` for UI assets plus both cf deployment dry runs. Deploy only when requested with `vp run deploy`.

Run `vp run types`, `vp check --deny-warnings`, `vp test`, and `vp run build` after changes. The replay test intentionally waits 67 seconds with real workerd time. Tests run locally without Cloudflare credentials or model inference. CI also requires `npm audit --audit-level=moderate`.

Keep all Vite+ configuration in the root `vite.config.ts`. Keep TypeScript strict mode, type-aware linting, warning failures, and every generic anti-slop rule enabled. Fix findings in owned source instead of suppressing them. Parse external values at their I/O boundaries; use named domain contracts. Run `vp check --fix` and verify a subsequent fix/format pass makes no changes.

The vendored anti-slop source and licenses live in `tools/oxlint/anti-slop/`; see its `UPSTREAM.md` before updating. Its plugin imports intentionally use `vite-plus/lint/plugins` to match the bundled Oxlint. Do not separately install Oxlint, Oxfmt, Vitest, tsdown, or their plugin runtime APIs.
