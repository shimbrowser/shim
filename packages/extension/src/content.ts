// The page runtime's entry for the default world (runtime.ts): registered per
// shim after the engine, in the user-script world in full mode and the
// isolated world in declarative mode, and injected into open documents.
// Vault shims never run here (vault-content.ts).

import { startRuntime } from './runtime';

startRuntime(null);
