// What a host that drives a page over the Chrome DevTools Protocol needs
// beside the PageHost contract, shared by the headless Playwright driver and
// Shim for Chrome's session host: a RemoteObject's value as returnByValue
// hands it back, Chromium's net error codes for a failed navigation, console
// levels and arguments as the PageHost reports them, and the handler source
// a host evaluates in the engine world. Pure.

import { handlerExpressionSource } from './handler-source';

/**
 * A CDP RemoteObject's value as returnByValue hands it back. JSON can't hold
 * NaN, ±Infinity, -0 or a bigint, so CDP sends those as `unserializableValue`
 * ("NaN", "-0", "12n", …) with no `value`: decoded here so a CDP host answers
 * what the Electron host does.
 */
export function remoteObjectValue(result: { value?: unknown; unserializableValue?: string }): unknown {
  const raw = result.unserializableValue;
  if (raw === undefined) return result.value;
  if (raw.endsWith('n')) {
    try { return BigInt(raw.slice(0, -1)); } catch { return undefined; }
  }
  if (raw === '-0') return -0;
  return Number(raw);
}

// Chromium's net error codes for the failures a navigation commonly reports
// (net/base/net_error_list.h), so `failed.code` reads the same as the Shim
// browser's did-fail-load. Anything unlisted is ERR_FAILED.
const NET_ERRORS: Record<string, number> = {
  'net::ERR_FAILED': -2,
  'net::ERR_ABORTED': -3,
  'net::ERR_TIMED_OUT': -7,
  'net::ERR_ACCESS_DENIED': -10,
  'net::ERR_BLOCKED_BY_CLIENT': -20,
  'net::ERR_BLOCKED_BY_RESPONSE': -27,
  'net::ERR_CONNECTION_CLOSED': -100,
  'net::ERR_CONNECTION_RESET': -101,
  'net::ERR_CONNECTION_REFUSED': -102,
  'net::ERR_CONNECTION_ABORTED': -103,
  'net::ERR_CONNECTION_FAILED': -104,
  'net::ERR_NAME_NOT_RESOLVED': -105,
  'net::ERR_INTERNET_DISCONNECTED': -106,
  'net::ERR_ADDRESS_UNREACHABLE': -109,
  'net::ERR_CERT_COMMON_NAME_INVALID': -200,
  'net::ERR_CERT_DATE_INVALID': -201,
  'net::ERR_CERT_AUTHORITY_INVALID': -202,
  'net::ERR_EMPTY_RESPONSE': -324,
  'net::ERR_TOO_MANY_REDIRECTS': -310,
};

export function netErrorCode(errorText: string): number {
  const key = errorText.trim().split(/\s/)[0] ?? '';
  return NET_ERRORS[key] ?? -2;
}

/** CDP console types → the PageHost levels (the Shim browser's names). */
export function consoleLevel(type: string): string {
  if (type === 'warning') return 'warning';
  if (type === 'error' || type === 'assert') return 'error';
  if (type === 'debug') return 'debug';
  return 'info';
}

export interface RemoteValue {
  type: string;
  value?: unknown;
  description?: string;
  unserializableValue?: string;
}

export function formatConsoleArg(arg: RemoteValue): string {
  if (arg.type === 'string' && typeof arg.value === 'string') return arg.value;
  if (arg.unserializableValue !== undefined) return arg.unserializableValue;
  if (arg.value !== undefined) {
    try { return typeof arg.value === 'object' ? JSON.stringify(arg.value) : String(arg.value); } catch { /* fall through */ }
  }
  return arg.description ?? arg.type;
}

/**
 * A handler compiled the way the Shim browser's preload compiles it: the
 * same handlerExpressionSource wrap and trailing sourceURL layout, so stack
 * line and column numbers match across hosts and a source ending in a
 * `// comment` can't swallow the closing paren (the pragma must end its line).
 */
export function handlerSource(source: string, ruleKey: string, name: string): string {
  return `${handlerExpressionSource(source)}\n//# sourceURL=shim://patches/${ruleKey}/handlers/${name}.js\n`;
}
