import { test } from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { smoke } from './smoke.mjs';

test('real caller and receiver Workers complete the synthetic account flow through service bindings', async () => {
  const caller = 'https://caller.test', store = 'https://store.test';
  const manifest = contents => ({ mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents } } });
  const [callerBuild, receiverBuild] = await Promise.all(['caller', 'receiver'].map(side => build({ entryPoints: [`workers/${side}/src/index.ts`], bundle: true, write: false, format: 'esm', platform: 'node', external: ['cloudflare:*'], logLevel: 'silent' })));
  const common = { CALLER_ORIGIN: { type: 'json', value: caller }, RECEIVER_ORIGIN: { type: 'json', value: store }, LOCAL_DEMO: { type: 'json', value: 'false' } };
  const mf = new Miniflare({ unsafeLocalExplorer: false, workers: [
    { config: { triggers: [{ type: 'fetch', pattern: 'caller.test/*' }], name: 'caller', domains: ['caller.test'], compatibilityDate: '2026-10-09', compatibilityFlags: ['nodejs_compat'], manifest: manifest(callerBuild.outputFiles[0].text), exports: { AgentIdentity: { type: 'durable-object', storage: 'sqlite' }, CallerSession: { type: 'durable-object', storage: 'sqlite' } }, env: { ...common, IDENTITY: { type: 'durable-object', worker: 'caller', exportName: 'AgentIdentity' }, VISITORS: { type: 'durable-object', worker: 'caller', exportName: 'CallerSession' }, RECEIVER: { type: 'worker', worker: 'receiver' }, AI: { type: 'json', value: {} }, MODEL: { type: 'json', value: '@cf/moonshotai/kimi-k2.7-code' }, ASSETS: { type: 'worker', worker: 'assets' } } } },
    { config: { triggers: [{ type: 'fetch', pattern: 'store.test/*' }], name: 'receiver', domains: ['store.test'], compatibilityDate: '2026-10-09', compatibilityFlags: ['nodejs_compat'], manifest: manifest(receiverBuild.outputFiles[0].text), exports: { CompanyUser: { type: 'durable-object', storage: 'sqlite' }, ReplayGuard: { type: 'durable-object', storage: 'sqlite' } }, env: { ...common, OWNERS: { type: 'durable-object', worker: 'receiver', exportName: 'CompanyUser' }, GUARDS: { type: 'durable-object', worker: 'receiver', exportName: 'ReplayGuard' }, CALLER: { type: 'worker', worker: 'caller' } } } },
    { config: { name: 'assets', compatibilityDate: '2026-10-09', manifest: manifest('export default { fetch() { return new Response("<!doctype html><title>Caller test</title>"); } }') } }
  ] });
  try {
    const callerWorker = await mf.getWorker('caller'), receiver = await mf.getWorker('receiver');
    await smoke({ caller, store, fetch: (url, init) => new URL(url).origin === caller ? callerWorker.fetch(url, init) : receiver.fetch(url, init) });
  } finally { await mf.dispose(); }
});
