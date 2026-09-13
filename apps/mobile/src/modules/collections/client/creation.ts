import { useMutation, useQueryClient } from '@tanstack/react-query';

import { mobileApi } from '../../../infrastructure/api';
import type { CreateContainerInput } from '../../../infrastructure/api/contracts';
import { invalidateHierarchy } from './queries';

/**
 * Sends one creation attempt. A thrown error from the boundary is not "not created": the request
 * may have left, so the sheet treats a rejection of this promise as an uncertain outcome.
 */
export function useCreateContainer() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateContainerInput) => mobileApi.createContainer(input),
    onSuccess: (outcome, input) => {
      if (outcome.kind === 'created') {
        void invalidateHierarchy(client, input.parentAreaId);
      }
    },
  });
}

/** Asks what became of an attempt, by its key. */
export function useCheckAttempt() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ attemptKey }: { attemptKey: string; parentAreaId: string | null }) =>
      mobileApi.checkAttempt(attemptKey),
    onSuccess: (result, input) => {
      if (result.kind === 'created') {
        void invalidateHierarchy(client, input.parentAreaId);
      }
    },
  });
}
