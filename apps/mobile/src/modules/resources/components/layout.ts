import type { Resource, ResourceKind } from '../../../infrastructure/api/contracts';

/** `full` is a full-width card; `column` is the narrow card used inside a grid column. */
export type ResourceCardLayout = 'full' | 'column';

/** One entry in a resource grid. `span: 'full'` forces a full-width row. */
export interface ResourceGridItem {
  resource: Resource;
  span?: 'full' | undefined;
}

/**
 * Relative heights, used only to decide which column a card joins. Images are tall, a
 * repository link is short; the numbers are ratios, not pixels.
 */
const ESTIMATED_HEIGHT: Record<ResourceKind, number> = {
  image: 1.6,
  voice: 1,
  note: 0.9,
  github: 0.8,
};

/** A full-width card, or a pair of columns holding the cards between two full rows. */
export type ResourceGridBlock =
  | { kind: 'full'; resource: Resource }
  | { kind: 'columns'; left: Resource[]; right: Resource[] };

/**
 * Turns a resource list into grid blocks. Items keep their order: a `full` item breaks
 * the flow into its own row, and everything between two full rows is dealt into two
 * columns, each card joining whichever column is currently shorter.
 */
export function buildResourceGrid(items: readonly ResourceGridItem[]): ResourceGridBlock[] {
  const blocks: ResourceGridBlock[] = [];

  let left: Resource[] = [];
  let right: Resource[] = [];
  let leftHeight = 0;
  let rightHeight = 0;

  const flushColumns = (): void => {
    if (left.length > 0 || right.length > 0) {
      blocks.push({ kind: 'columns', left, right });
      left = [];
      right = [];
      leftHeight = 0;
      rightHeight = 0;
    }
  };

  for (const item of items) {
    if (item.span === 'full') {
      flushColumns();
      blocks.push({ kind: 'full', resource: item.resource });

      continue;
    }

    const height = ESTIMATED_HEIGHT[item.resource.kind];

    if (leftHeight <= rightHeight) {
      left.push(item.resource);
      leftHeight += height;
    } else {
      right.push(item.resource);
      rightHeight += height;
    }
  }

  flushColumns();

  return blocks;
}
