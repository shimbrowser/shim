// The chrome.* API types for every file in this package, wherever it is
// typechecked (the package's own tsconfig names them; the repo-root one
// does not, so this reference carries them there).
/// <reference types="chrome" />

/** The package version, defined by the build (scripts/build.js). */
declare const SHIM_EXTENSION_VERSION: string;

/**
 * True only in dist-test/, the build the real-browser harnesses load. The
 * build defines it (scripts/build.js), so a shipped worker holds none of what
 * this guards. Read it in sw.ts alone: only that entry is built both ways.
 */
declare const SHIM_EXTENSION_TEST_BUILD: boolean;
