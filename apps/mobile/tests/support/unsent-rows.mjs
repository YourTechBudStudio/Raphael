/** `unsent` rows for tests, with the fields a test does not care about filled in. */

import { createEmptyDocument } from '@raphael/content';

export const createRow = (over = {}) => ({
  id: 'draft-1',
  op: 'create',
  nodeType: 'resource',
  kind: 'note',
  nodeId: null,
  baseRevision: null,
  destination: null,
  title: 'Still being written',
  description: '',
  slug: '',
  tags: [],
  body: createEmptyDocument(),
  status: 'draft',
  error: null,
  version: 1,
  sentVersion: 0,
  updatedAt: 1,
  ...over,
});

export const editRow = (nodeId, over = {}) =>
  createRow({
    id: `edit-${String(nodeId)}`,
    op: 'edit',
    nodeId,
    baseRevision: 1,
    slug: `note-${String(nodeId)}`,
    title: `note ${String(nodeId)}`,
    status: 'pending',
    version: 2,
    sentVersion: 1,
    ...over,
  });
