// The chrome.* API types for every file in this package, wherever it is
// typechecked (the package's own tsconfig names them; the repo-root one
// does not, so this reference carries them there).
/// <reference types="chrome" />

/** The package version, defined by the build (scripts/build.js). */
declare const SHIM_EXTENSION_VERSION: string;
