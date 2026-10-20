// An api whose every reported event carries one application's tag. A host
// that applies the same preview key more than once (an agent's edit, a replay
// onto a fresh document) stamps each application with its own `applyId`, so a
// consumer can tell which application produced an event, however late the
// event arrives: a witness the previous application captured after the next
// one started is still that application's (PreviewRule.applyId).
//
// The tag is stamped where the event is produced, never where it is received:
// the rule's setup holds this api for its whole life, so a deferred report
// from a replaced application carries that application's id.

import type { CoreApi } from './api';

export function taggedApi<A extends CoreApi>(api: A, applyId: string | undefined): A {
  if (typeof applyId !== 'string' || applyId === '') return api;
  // Prototype inheritance, as the engine's per-mount api does: every other
  // member (storage, bridge, the host's capabilities) is the host's own.
  const tagged = Object.create(api) as A;
  Object.defineProperty(tagged, 'reportEvent', {
    configurable: true,
    enumerable: true,
    writable: true,
    value(kind: string, payload?: Record<string, unknown>): void {
      api.reportEvent(kind, { ...(payload ?? {}), applyId });
    },
  });
  return tagged;
}
