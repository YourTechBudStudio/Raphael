import type { ParentRef } from '../../infrastructure/api/contracts';

/** Reads a search scope out of route params, ignoring anything that is not a collection. */
export function parseScope(type: string | undefined, id: string | undefined): ParentRef | null {
  if (id === undefined || id === '') {
    return null;
  }

  return type === 'area' || type === 'project' ? { type, id } : null;
}
