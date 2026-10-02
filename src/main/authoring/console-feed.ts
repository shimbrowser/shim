// The console buffer and its formatters live in @shimbrowser/core (one
// implementation for every host's read_console and preview evidence,
// shim-core design D11); re-exported so the browser's callers keep one import.
export * from '@shimbrowser/core/console-feed';
