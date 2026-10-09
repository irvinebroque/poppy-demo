import { bindings, defineConfig, exports } from 'cf/config';
const worker = process.env.POPPY_CALLER_NAME ?? 'poppy-caller';
const receiver = process.env.POPPY_RECEIVER_NAME ?? 'poppy-receiver';
export default defineConfig({ worker: {
  name: worker, entrypoint: 'src/index.ts', compatibilityDate: '2026-10-09',
  compatibilityFlags: ['nodejs_compat'], workersDev: true,
  assets: { runWorkerFirst: true },
  observability: { enabled: true, headSamplingRate: 1 },
  exports: { AgentIdentity: exports.durableObject({ storage: 'sqlite' }), CallerSession: exports.durableObject({ storage: 'sqlite' }) },
  env: {
    ASSETS: bindings.assets(),
    CALLER_ORIGIN: bindings.text(process.env.POPPY_CALLER_ORIGIN ?? 'http://localhost:8787'),
    RECEIVER_ORIGIN: bindings.text(process.env.POPPY_RECEIVER_ORIGIN ?? 'http://localhost:8788'),
    LOCAL_DEMO: bindings.text(process.env.POPPY_LOCAL_DEMO ?? 'true'),
    MODEL: bindings.text(process.env.POPPY_MODEL ?? '@cf/moonshotai/kimi-k2.7-code'),
    RECEIVER: bindings.worker({ worker: receiver }),
    IDENTITY: bindings.durableObject({ worker, exportName: 'AgentIdentity' }),
    VISITORS: bindings.durableObject({ worker, exportName: 'CallerSession' }),
    AI: bindings.ai({ dev: { remote: true } })
  }
} });
