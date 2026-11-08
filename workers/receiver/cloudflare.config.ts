import { bindings, defineConfig, exports } from "cf/config";

const worker = process.env.POPPY_RECEIVER_NAME ?? "poppy-receiver";

export default defineConfig({
  worker: {
    name: worker,
    entrypoint: "src/index.ts",
    compatibilityDate: "2026-10-09",
    compatibilityFlags: ["nodejs_compat"],
    workersDev: true,
    observability: { enabled: true, headSamplingRate: 1 },
    exports: {
      MoleAnchor: exports.durableObject({ storage: "sqlite" }),
      MoleModerator: exports.durableObject({ storage: "sqlite" }),
      CompanyUser: exports.durableObject({ storage: "sqlite" }),
      ReplayGuard: exports.durableObject({ storage: "sqlite" }),
    },
    env: {
      CALLER_ORIGIN: bindings.text(process.env.POPPY_CALLER_ORIGIN ?? "http://localhost:8787"),
      RECEIVER_ORIGIN: bindings.text(process.env.POPPY_RECEIVER_ORIGIN ?? "http://localhost:8788"),
      LOCAL_DEMO: bindings.text(process.env.POPPY_LOCAL_DEMO ?? "true"),
      CALLER:
        process.env.POPPY_BOOTSTRAP === "true"
          ? undefined
          : bindings.worker({ worker: process.env.POPPY_CALLER_NAME ?? "poppy-caller" }),
      MOLE_ANCHOR: bindings.durableObject({ worker, exportName: "MoleAnchor" }),
      MOLE_MODERATOR: bindings.durableObject({ worker, exportName: "MoleModerator" }),
      OWNERS: bindings.durableObject({ worker, exportName: "CompanyUser" }),
      GUARDS: bindings.durableObject({ worker, exportName: "ReplayGuard" }),
    },
  },
});
