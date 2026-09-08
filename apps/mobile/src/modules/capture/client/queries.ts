import { useQuery } from '@tanstack/react-query';

import { mobileApi } from '../../../infrastructure/api';
import type { CaptureTarget } from '../../../infrastructure/api/contracts';

/** Resolve destinations through the backend boundary, including Home's default inbox. */
export function useCaptureLocation(target: CaptureTarget, visible: boolean) {
  return useQuery({
    queryKey: ['capture-location', target.type, target.id ?? null],
    queryFn: () => mobileApi.getCaptureLocationPath(target),
    enabled: visible,
  });
}
