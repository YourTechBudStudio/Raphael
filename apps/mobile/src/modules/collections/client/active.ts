import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';

import { mobileApi } from '../../../infrastructure/api';

const ACTIVE_KEY = ['active-projects'] as const;
const ACTIVE_WRITE_KEY = ['set-project-active'] as const;

interface ActiveInput {
  id: string;
  active: boolean;
}

export function useActiveProjects() {
  return useQuery({ queryKey: ACTIVE_KEY, queryFn: () => mobileApi.getActiveProjects() });
}

/** Shared pending intent keeps Home and project controls in agreement during a write. */
export function useProjectActive() {
  const projects = useActiveProjects();
  const client = useQueryClient();
  const pending = useMutationState({
    filters: { mutationKey: ACTIVE_WRITE_KEY, status: 'pending' },
    select: (mutation) => mutation.state.variables as ActiveInput,
  });
  const mutation = useMutation({
    mutationKey: ACTIVE_WRITE_KEY,
    scope: { id: 'project-active' },
    mutationFn: ({ id, active }: ActiveInput) => mobileApi.setProjectActive(id, active),
    onSuccess: () => client.invalidateQueries({ queryKey: ACTIVE_KEY }),
  });

  const isActive = (id: string): boolean =>
    pending.findLast((input) => input.id === id)?.active ??
    projects.data?.some((project) => project.id === id) ??
    false;

  const isDisabled = (id: string): boolean =>
    projects.data === undefined || pending.some((input) => input.id === id);

  return {
    isActive,
    isDisabled,
    isError: mutation.isError || projects.isError,
    toggle: (id: string) => {
      if (!isDisabled(id)) {
        mutation.mutate({ id, active: !isActive(id) });
      }
    },
  };
}
