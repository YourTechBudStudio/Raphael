import { useLocalSearchParams } from 'expo-router';

import { ProjectScreen } from '../../modules/collections';

/**
 * A deep link can arrive without an id; passing the empty string through lets the screen say
 * the project is not here rather than querying for `undefined`.
 */
export default function ProjectRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();

  return <ProjectScreen projectId={id ?? ''} />;
}
