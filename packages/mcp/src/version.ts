// The @shimbrowser/mcp version both entry points report (`shim-mcp`, `shim`).

// Replaced at bundle time (scripts/build.js); the package version otherwise.
declare const SHIM_MCP_VERSION: string | undefined;

export const VERSION: string = typeof SHIM_MCP_VERSION === 'string' ? SHIM_MCP_VERSION : '0.7.0';
