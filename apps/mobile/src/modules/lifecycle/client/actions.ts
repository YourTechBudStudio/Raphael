import type { ClientFailure } from '@raphael/client';
import { archive, restore } from '@raphael/client/nodes';
import type { LifecycleResponse, NodeEntity } from '@raphael/contracts/nodes';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { asClientFailure, unwrap } from '../../../infrastructure/query/failure';
import { invalidateActivation } from '../../../infrastructure/query/invalidate';
import { nodeKey, scopeKey } from '../../../infrastructure/query/keys';
import { useConnectionSession } from '../../connection';
import { failedActionSentence, type LifecycleVerb } from '../copy.ts';

/**
 * Archive and restore: one request against the revision the screen read, then a re-read.
 *
 * The re-read is broad, because archiving changes what every list, feed, search and hierarchy read
 * holds. An editor's open node is patched with the new revision and causes instead, so its next edit
 * starts from the right revision.
 */

const LIFECYCLE_WRITE = 'container-lifecycle';

export interface LifecycleActionInput {
  readonly id: number;
  /** The revision the screen read. */
  readonly revision: number;
  readonly verb: LifecycleVerb;
}

export interface LifecycleAction {
  /** Resolves with the failure, or null once it worked. Does nothing while one is running. */
  run(input: LifecycleActionInput): Promise<ClientFailure | null>;
  readonly pending: boolean;
  /** This instance's last failure, as one sentence, until the next request. */
  readonly failureMessage: string | null;
}

const ACTION: Record<LifecycleVerb, string> = {
  archive: 'Couldn’t archive',
  restore: 'Couldn’t restore',
};

export function useLifecycleAction(): LifecycleAction {
  const session = useConnectionSession();
  const client = useQueryClient();
  const activation = session?.activation ?? -1;
  const mutation = useMutation({
    mutationKey: scopeKey(activation, LIFECYCLE_WRITE),
    mutationFn: async ({ id, revision, verb }: LifecycleActionInput) => {
      if (session === null) throw new Error('No connection');

      const send = verb === 'archive' ? archive : restore;

      return unwrap(await send(session.transport, { target: { id }, revision }));
    },
    onSuccess: ({ node, archiveCauses }: LifecycleResponse) => {
      client.setQueryData<NodeEntity>(nodeKey(activation, node.id), (entity) =>
        entity === undefined
          ? undefined
          : { ...entity, revision: node.revision, archived: node.archived, archiveCauses },
      );

      // Awaited, so the toggle stays busy until the state that replaces it has arrived.
      return invalidateActivation(client, activation);
    },
    onError: () => {
      void invalidateActivation(client, activation);
    },
  });

  return {
    run: async (input) => {
      if (mutation.isPending) return null;

      try {
        await mutation.mutateAsync(input);

        return null;
      } catch (error) {
        return asClientFailure(error) ?? { kind: 'network', message: String(error) };
      }
    },
    pending: mutation.isPending,
    failureMessage:
      mutation.error === null
        ? null
        : failedActionSentence(
            ACTION[mutation.variables?.verb ?? 'archive'],
            asClientFailure(mutation.error),
          ),
  };
}
