import { cf } from './cf.mjs';
const subdomain = process.env.POPPY_WORKERS_SUBDOMAIN;
if (!subdomain || !/^[a-z0-9-]+\.workers\.dev$/.test(subdomain)) throw new Error('Set POPPY_WORKERS_SUBDOMAIN to your account subdomain, for example example.workers.dev.');
const caller = process.env.POPPY_CALLER_NAME ?? 'poppy-caller';
const receiver = process.env.POPPY_RECEIVER_NAME ?? 'poppy-receiver';
const env = { POPPY_CALLER_ORIGIN: `https://${caller}.${subdomain}`, POPPY_RECEIVER_ORIGIN: `https://${receiver}.${subdomain}`, POPPY_LOCAL_DEMO: 'false' };
// Bootstrap the receiver to satisfy the first deployment's circular service bindings.
await cf('receiver', ['deploy'], { ...env, POPPY_BOOTSTRAP: 'true' });
await cf('caller', ['deploy'], env);
await cf('receiver', ['deploy'], { ...env, POPPY_BOOTSTRAP: 'false' });
console.log(`\nPersonal agent: ${env.POPPY_CALLER_ORIGIN}\nCompany website: ${env.POPPY_RECEIVER_ORIGIN}`);
