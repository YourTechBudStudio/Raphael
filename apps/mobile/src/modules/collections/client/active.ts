import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';

import { localContent } from '../../../infrastructure/api';
import { scopeKey } from '../../../infrastructure/query/keys';
import { useConnectionSession } from '../../connection';

/**
 * Which projects are deliberately active, by id.
 *
 * References, like favorites: a selection stores the server's numeric project id and nothing else,
 * and Home resolves those ids against the hierarchy when it renders. Session-only, and scoped to
 * the connection they were chosen under.
 */

const ACTIVE = 'active-projects';
const ACTIVE_WRITE_KEY = ['set-project-active'] as const;

interface ActiveInput {
  id: number;
  active: boolean;
}

export function useActiveProjectIds() {
  const session = useConnectionSession();
  const connectionId = session?.connection.connectionId ?? null;

  return useQuery({
    queryKey: scopeKey(session?.activation ?? -1, ACTIVE),
    queryFn: (): Promise<number[]> => {
      if (connectionId === null) throw new Error('No connection');

      return localContent.getActiveProjects(connectionId);
    },
    enabled: connectionId !== null,
  });
}

/** Shared pending intent keeps Home and the project screen in agreement during a write. */
export function useProjectActive() {
  const session = useConnectionSession();
  const connectionId = session?.connection.connectionId ?? null;
  const selected = useActiveProjectIds();
  const client = useQueryClient();
  const pending = useMutationState({
    filters: { mutationKey: ACTIVE_WRITE_KEY, status: 'pending' },
    select: (mutation) => mutation.state.variables as ActiveInput,
  });
  const mutation = useMutation({
    mutationKey: ACTIVE_WRITE_KEY,
    scope: { id: 'project-active' },
    mutationFn: ({ id, active }: ActiveInput) => {
      if (connectionId === null) throw new Error('No connection');

      return localContent.setProjectActive(connectionId, id, active);
    },
    onSuccess: () =>
      client.invalidateQueries({ predicate: (query) => query.queryKey[2] === ACTIVE }),
  });

  const isActive = (id: number): boolean =>
    pending.findLast((input) => input.id === id)?.active ?? selected.data?.includes(id) ?? false;

  const isDisabled = (id: number): boolean =>
    selected.data === undefined || pending.some((input) => input.id === id);

  return {
    isActive,
    isDisabled,
    isError: mutation.isError || selected.isError,
    toggle: (id: number) => {
      if (!isDisabled(id)) mutation.mutate({ id, active: !isActive(id) });
    },
  };
}
