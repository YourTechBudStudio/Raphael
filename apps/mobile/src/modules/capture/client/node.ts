/**
 * The editor's server reads and plain actions for one node.
 *
 * The node is read fresh each time the editor opens and never refreshed behind it: its revision is
 * the one new writing is based on (see `nodeKey`). A move patches that revision in, so the next edit
 * starts from it.
 */

import { get as getNode, move } from '@raphael/client/nodes';
import { ROOT_PATH, type NodeEntity } from '@raphael/contracts/nodes';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import { unwrap } from '../../../infrastructure/query/failure';
import { invalidateActivation } from '../../../infrastructure/query/invalidate';
import { nodeKey } from '../../../infrastructure/query/keys';
import { useConnectionSession } from '../../connection';

export const useNode = (id: number | null): UseQueryResult<NodeEntity> => {
  const session = useConnectionSession();

  return useQuery({
    queryKey: nodeKey(session?.activation ?? -1, id ?? 0),
    queryFn: async ({ signal }) => {
      if (session === null || id === null) throw new Error('No connection');

      return unwrap(await getNode(session.transport, { target: { id }, format: 'tiptap' }, signal))
        .entity;
    },
    enabled: session !== null && id !== null,
    staleTime: Infinity,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
};

export interface MoveInput {
  readonly id: number;
  readonly revision: number;
  /** Null is the top level. The node keeps its slug. */
  readonly parentId: number | null;
}

export const useMoveNode = () => {
  const session = useConnectionSession();
  const client = useQueryClient();
  const activation = session?.activation ?? -1;

  return useMutation({
    mutationFn: async ({ id, revision, parentId }: MoveInput) => {
      if (session === null) throw new Error('No connection');

      return unwrap(
        await move(session.transport, {
          target: { id },
          revision,
          destination: { parent: parentId === null ? { path: ROOT_PATH } : { id: parentId } },
        }),
      ).node;
    },
    onSuccess: (node) => {
      client.setQueryData<NodeEntity>(nodeKey(activation, node.id), (entity) =>
        entity === undefined
          ? undefined
          : {
              ...entity,
              parentId: node.parentId,
              slug: node.slug,
              revision: node.revision,
              archived: node.archived,
              // Moving somewhere active is the way out of an inherited archive; a move into an
              // archived place is refused, so a node still archived kept its causes.
              archiveCauses: node.archived ? entity.archiveCauses : [],
            },
      );
    },
    onSettled: () => invalidateActivation(client, activation),
  });
};
