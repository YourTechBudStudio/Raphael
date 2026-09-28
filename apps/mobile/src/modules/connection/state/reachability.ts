/**
 * Whether this phone can reach its server, as the last request said.
 *
 * Fed from one place: every transport the connection builds reports each result here. A network or
 * timeout failure means offline; any answer from the server, even an error, means online. A caller
 * cancelling says nothing either way.
 */

import type { ClientResult } from '@raphael/client';
import { create } from 'zustand';

export const useReachability = create<{ readonly online: boolean }>(() => ({ online: true }));

export const isOnline = (): boolean => useReachability.getState().online;

export const noteResult = (result: ClientResult<unknown>): void => {
  if (result.ok) {
    setOnline(true);

    return;
  }

  const { kind } = result.failure;

  if (kind === 'network' || kind === 'timeout') setOnline(false);
  if (kind === 'http' || kind === 'bad_response') setOnline(true);
};

const setOnline = (online: boolean): void => {
  if (useReachability.getState().online !== online) useReachability.setState({ online });
};

/** Calls `listener` each time the server becomes reachable again. */
export const onBackOnline = (listener: () => void): (() => void) =>
  useReachability.subscribe((state, previous) => {
    if (state.online && !previous.online) listener();
  });
