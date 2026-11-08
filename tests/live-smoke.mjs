import { smoke } from './smoke.mjs';
const caller = process.env.POPPY_CALLER_ORIGIN ?? 'https://poppy-caller.roundtrip.workers.dev';
const store = process.env.POPPY_RECEIVER_ORIGIN ?? 'https://poppy-receiver.roundtrip.workers.dev';
await smoke({ caller, store });
console.log('Live HTTPS smoke passed: Poppy 0.4 discovery, signed-out conversation, OAuth/PKCE, account APIs, continued conversation, simulated exchange, new Session, direct conversation, handoff/cancel, close, revocation, visitor isolation and CSRF.');
