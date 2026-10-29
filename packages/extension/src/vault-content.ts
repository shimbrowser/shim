// The page runtime's entry for a vault shim's own world (runtime.ts,
// vault.ts). Never registered as a file: the worker reads this bundle's
// source and registers it as code wrapped in a closure whose parameter is the
// boot it plants (vaultBootCode), so the token reaches the runtime without
// ever being a global another script in the world could read first.

import { startRuntime } from './runtime';
import type { VaultBoot } from './vault';

declare const __SHIM_VAULT__: VaultBoot;

startRuntime(__SHIM_VAULT__);
