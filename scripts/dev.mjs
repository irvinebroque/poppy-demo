import { prepare } from './cf.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
prepare();
const children = ['caller', 'receiver'].map(side => spawn(process.execPath,
  [fileURLToPath(new URL('../node_modules/cf/bin/cf', import.meta.url)), 'dev'], {
    cwd: new URL(`../workers/${side}/`, import.meta.url), stdio: 'inherit', detached: process.platform !== 'win32',
    env: { ...process.env, CLOUDFLARE_REGISTRY_PATH: fileURLToPath(new URL('../.cloudflare/registry', import.meta.url)), WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: '/tmp/poppy-wrangler-logs', CHOKIDAR_USEPOLLING: 'true' }
  }));
let stopping = false;
function stop(code = 0) {
  if (stopping) return; stopping = true; process.exitCode = code;
  for (const child of children) {
    try { process.platform === 'win32' ? child.kill('SIGTERM') : process.kill(-child.pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
for (const child of children) { child.on('error', error => { console.error(error.message); stop(1); }); child.on('exit', code => stop(code ?? 0)); }
