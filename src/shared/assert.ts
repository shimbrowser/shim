// `must` lives in the patch engine (src/patch-engine/assert.ts) so the engine
// imports nothing outside itself (shim-core design D4/D5). Re-exported here so
// the rest of the app keeps importing it from src/shared.
export { must } from '../patch-engine/assert';
