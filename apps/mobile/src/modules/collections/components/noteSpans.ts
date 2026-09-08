import type { Resource } from '../../../infrastructure/api/contracts';
import type { ResourceGridItem } from '../../resources';

/**
 * Decides which card in a section gets the full width, reproducing the Area boards from the
 * resource order alone (newest first) rather than from hand-placed layout data.
 *
 * The rule: a note that leads the section spans the full width, because its text reads best
 * across the whole gutter when it is the first thing under the heading; otherwise a voice note
 * that closes the section spans the full width, because its waveform and play control need the
 * room. At most one card is promoted, so the rest still pair up into columns.
 *
 * Creative work (image, note, voice) therefore pairs the image with the note and gives the voice
 * card the full width; Design (note, image, voice) leads with the full-width note and pairs the
 * image with the voice card. A lone card also spans the full width, so a section never renders
 * a single half-width card against empty space. Both match `areas/area-with-subareas-v2.png` and
 * `areas/area-without-subareas-v2.png`.
 */
export function areaNoteGridItems(resources: readonly Resource[]): ResourceGridItem[] {
  const first = resources[0];
  const last = resources[resources.length - 1];

  const fullId =
    first === undefined
      ? undefined
      : resources.length === 1 || first.kind === 'note'
        ? first.id
        : last !== undefined && last.kind === 'voice'
          ? last.id
          : undefined;

  return resources.map((resource) =>
    resource.id === fullId ? { resource, span: 'full' } : { resource },
  );
}
