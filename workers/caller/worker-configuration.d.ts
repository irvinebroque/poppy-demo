// Environment inferred from the canonical cf config; namespace types narrow RPC stubs.
import type { InferEnv, UnwrapConfig } from 'cf/config';
import type config from './cloudflare.config';
import type { AgentIdentity, CallerSession } from './src/index';
type ConfigEnv = InferEnv<UnwrapConfig<UnwrapConfig<typeof config>['worker']>>;
declare global {
  type CallerEnv = Omit<ConfigEnv, 'IDENTITY' | 'VISITORS'> & {
    IDENTITY: DurableObjectNamespace<AgentIdentity>;
    VISITORS: DurableObjectNamespace<CallerSession>;
  };
}
