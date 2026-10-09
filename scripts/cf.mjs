import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
export function prepare() {
  // cf beta discovers the dev-server only in the Worker's own node_modules.
  for (const side of ['caller', 'receiver']) {
    const modules = new URL(`workers/${side}/node_modules/`, root);
    mkdirSync(modules, { recursive: true });
    const wrangler = new URL('wrangler', modules);
    if (!existsSync(wrangler)) symlinkSync('../../../node_modules/wrangler', wrangler, 'dir');
  }
}
export function cf(side, args, extra = {}) {
  prepare();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('node_modules/cf/bin/cf', root)), ...args], {
      cwd: new URL(`workers/${side}/`, root), stdio: 'inherit',
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: '/tmp/poppy-wrangler-logs', CLOUDFLARE_REGISTRY_PATH: fileURLToPath(new URL('.cloudflare/registry', root)), ...extra }
    });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`cf ${args.join(' ')} failed (${code})`)));
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  prepare();
  if (process.argv.length > 2) for (const side of ['receiver', 'caller']) await cf(side, process.argv.slice(2));
}
