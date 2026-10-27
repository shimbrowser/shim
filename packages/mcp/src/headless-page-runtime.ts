// The in-page runtime a CDP host injects now lives in core
// (@shimbrowser/core/page-runtime), shared with Shim for Chrome's session
// host; this module keeps the headless driver's name for it.

export { installPageRuntime, pageRuntimeSource } from '@shimbrowser/core/page-runtime';
export type { PageRuntimeConfig, PageRuntimeControl } from '@shimbrowser/core/page-runtime';
