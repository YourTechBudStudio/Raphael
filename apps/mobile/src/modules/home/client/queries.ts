import { useLocalResources } from '../../resources';

/** How many recent notes Home shows. */
const HOME_FEED_SIZE = 4;

/**
 * The most recent notes across everywhere, newest first.
 *
 * A slice of the one local-resources query rather than a query of its own, so Home and an area
 * screen can never be showing two different answers about the same note.
 */
export function useHomeFeed() {
  const resources = useLocalResources();

  return {
    ...resources,
    data: resources.data === undefined ? undefined : resources.data.slice(0, HOME_FEED_SIZE),
  };
}
