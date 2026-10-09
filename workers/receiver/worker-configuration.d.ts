// Environment inferred from the canonical cf config; namespace types narrow RPC stubs.
import type { InferEnv, UnwrapConfig } from 'cf/config';
import type config from './cloudflare.config';
import type { CompanyUser, ReplayGuard } from './src/index';
type ConfigEnv = InferEnv<UnwrapConfig<UnwrapConfig<typeof config>['worker']>>;
declare global {
  type ReceiverEnv = Omit<ConfigEnv, 'OWNERS' | 'GUARDS'> & {
    OWNERS: DurableObjectNamespace<CompanyUser>;
    GUARDS: DurableObjectNamespace<ReplayGuard>;
  };
}
