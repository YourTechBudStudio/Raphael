import { addFavorite, removeFavorite } from '@raphael/client/nodes';
import {
  skipToken,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { asClientFailure, unwrap } from '../../../infrastructure/query/failure';
import { invalidateActivation } from '../../../infrastructure/query/invalidate';
import { scopeKey } from '../../../infrastructure/query/keys';
import { nextReadStamp } from '../../../infrastructure/query/read-stamp';
import { useConnectionSession } from '../../connection';

/**
 * The favorite star, as server state.
 *
 * Shaped like `collections/client/active.ts::useProjectActive`, and different from it in one place
 * that carries the whole design: what the star shows between the server's answer and the next read.
 *
 * **The wire carries the desired state, never a toggle.** A tap sends `addFavorite` or
 * `removeFavorite` for the opposite of what the star shows, and the star is disabled while that write
 * is in flight. Two requests from one phone therefore cannot arrive in the opposite order and leave
 * the server holding the state the person did not end on.
 *
 * **What a star shows**, first match wins:
 *
 * 1. the intent of a write for this node still in flight, read from the mutation cache, so every star
 *    for one node agrees whichever control sent it;
 * 2. the server's confirmed answer, while the read the star was drawn from was *requested* before
 *    that confirmation;
 * 3. the read itself.
 *
 * **The freshness boundary.** A confirmed answer gives way only to a read of that node requested
 * after the confirmation. Such a read reflects the write or something newer, because the server
 * commits before it answers and a read that starts after a commit sees it - including a change another
 * client made afterwards, which is why the answer gives way at all. Nothing else counts, even if it
 * arrived later: a read of the node requested before the confirmation, another page of the same list,
 * or a refetch that failed and kept its old data. Reads are ordered by `nextReadStamp()`, taken just
 * before each request is sent. `dataUpdatedAt` cannot do this: it records arrival rather than request,
 * and an infinite query moves it forward on `fetchNextPage` while older pages keep older contents.
 *
 * **Nothing is written into any node read.** The answer lives in one entry of its own, per
 * activation, written only by `onSuccess` here. It can change the star and nothing else, so no read's
 * content, revision or other fields can ever be overwritten by a favorite. On a refusal or a lost
 * answer nothing is recorded, and the star goes back to what the last read said.
 *
 * **Every read of the activation is refreshed, and nothing waits for it.** Every node read now
 * carries `isFavorite`, and the phone cannot list which cached reads contain a given node - a
 * container's Get, a children page, the favorites list - so the whole activation is invalidated, as
 * archive and restore do. It is not awaited, unlike `useProjectActive`'s: the confirmed answer already
 * shows the truth, so there is no flicker to hold the control back for. And a failed reread cannot
 * bring an old value back, because the read it failed to replace keeps its older stamp.
 *
 * Everything is scoped to one activation: the write key, the intent read from it, the confirmed
 * answers and the invalidation. Leaving a connection clears the cache, answers included.
 */

const FAVORITE_WRITE = 'favorite-write';
const FAVORITE_CONFIRMED = 'favorite-confirmed';

/** One node's favorite state as some read reported it, and when that read was requested. */
export interface FavoriteRead {
  readonly id: number;
  readonly isFavorite: boolean;
  /** The `nextReadStamp()` taken before the read that reported this was sent. */
  readonly requestedAt: number;
}

/** `failed`: the server refused. `unconfirmed`: the answer was lost. Null: no failure to report. */
export type FavoriteFailure = 'failed' | 'unconfirmed' | null;

export interface FavoriteToggle {
  /** Pending intent, else the confirmed answer if this read is older than it, else the read. */
  isFavorite(read: FavoriteRead): boolean;
  /** A write for this id is in flight. */
  isBusy(id: number): boolean;
  /** Sends the opposite of `isFavorite(read)` as add or remove. Does nothing while busy. */
  toggle(read: FavoriteRead): void;
  /**
   * Verdict of the last write issued through this instance: null until its first write, held after a
   * failure until this instance's next dispatch, null again after a later success from it.
   *
   * One instance per control, for the reason `useProjectActive` gives: a mutation observer reports
   * only its latest dispatch, so one instance shared by several stars would lose the first star's
   * failure as soon as a second was tapped.
   */
  readonly failure: FavoriteFailure;
}

interface FavoriteInput {
  readonly id: number;
  /** The state the server should hold afterwards. */
  readonly wanted: boolean;
}

interface Confirmed {
  readonly isFavorite: boolean;
  /** A read stamp taken when the answer arrived: every read requested after it is larger. */
  readonly confirmedAt: number;
}

type ConfirmedFavorites = Readonly<Record<number, Confirmed>>;

/** What add and remove both answer: the node, and the selection the server now holds for it. */
interface FavoriteAnswer {
  readonly nodeId: number;
  readonly isFavorite: boolean;
}

const NONE: ConfirmedFavorites = {};

export function useFavoriteToggle(): FavoriteToggle {
  const session = useConnectionSession();
  const client = useQueryClient();
  const activation = session?.activation ?? -1;
  const writeKey = scopeKey(activation, FAVORITE_WRITE);
  const confirmedKey = scopeKey(activation, FAVORITE_CONFIRMED);

  // Every in-flight write for this activation, so every star for one id agrees.
  const pending = useMutationState({
    filters: { mutationKey: writeKey, status: 'pending' },
    select: (mutation) => mutation.state.variables as FavoriteInput,
  });

  // Written only by `onSuccess` below and never fetched (`skipToken`), so invalidating the activation
  // marks it stale without ever replacing it. `gcTime: Infinity` because every toggle observes it
  // before it can write to it: the entry therefore always exists with this lifetime, and it outlives
  // every star unmounting. Otherwise a star mounted later, drawn from a reread that failed, would
  // show the value the server had already replaced. It stays tiny - one item per node toggled - and
  // `queryClient.clear()` drops it with the activation.
  const confirmed =
    useQuery({
      queryKey: confirmedKey,
      queryFn: skipToken,
      initialData: NONE,
      staleTime: Infinity,
      gcTime: Infinity,
    }).data ?? NONE;

  const mutation = useMutation({
    mutationKey: writeKey,
    // The session is captured from this render, so a write issued under one connection stays
    // addressed to that connection's transport, and its answer lands under that activation's keys.
    mutationFn: async ({ id, wanted }: FavoriteInput) => {
      if (session === null) throw new Error('No connection');

      const request = { target: { id } };
      const result = wanted
        ? await addFavorite(session.transport, request)
        : await removeFavorite(session.transport, request);

      return unwrap<FavoriteAnswer>(result);
    },
    // On the mutation rather than on each `mutate` call, so they run even if the star has unmounted.
    //
    // The order is the freshness rule. The answer takes its stamp first, and only then does the
    // invalidation start the rereads, so every one of them is requested after the confirmation and
    // carries a larger stamp. The other way round, a reread could be stamped before the answer, and
    // the star would ignore the one read that is allowed to replace it.
    onSuccess: (answer) => {
      client.setQueryData<ConfirmedFavorites>(confirmedKey, (current = NONE) => ({
        ...current,
        [answer.nodeId]: { isFavorite: answer.isFavorite, confirmedAt: nextReadStamp() },
      }));
      void invalidateActivation(client, activation);
    },
    // Nothing is recorded: the server refused, or its answer was lost and the change may or may not
    // have landed. The reread is what settles it.
    onError: () => {
      void invalidateActivation(client, activation);
    },
  });

  const intentFor = (id: number): FavoriteInput | undefined =>
    pending.findLast((input) => input.id === id);

  const isFavorite = (read: FavoriteRead): boolean => {
    const intent = intentFor(read.id);

    if (intent !== undefined) return intent.wanted;

    const answer = confirmed[read.id];

    return answer !== undefined && read.requestedAt < answer.confirmedAt
      ? answer.isFavorite
      : read.isFavorite;
  };

  const isBusy = (id: number): boolean => intentFor(id) !== undefined;

  return {
    isFavorite,
    isBusy,
    toggle: (read) => {
      if (isBusy(read.id)) return;

      mutation.mutate({ id: read.id, wanted: !isFavorite(read) });
    },
    // Read from this observer, so React Query's own lifecycle is the verdict's: reset on the next
    // dispatch, cleared by a success. Mutations do not retry (`query-client.ts`), so a refusal is
    // reported once.
    failure: failureOf(mutation.error),
  };
}

const failureOf = (error: unknown): FavoriteFailure => {
  if (error === null || error === undefined) return null;

  return asClientFailure(error)?.mutationOutcome === 'unknown' ? 'unconfirmed' : 'failed';
};
