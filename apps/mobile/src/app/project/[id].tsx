import { useLocalSearchParams } from 'expo-router';

import { ProjectScreen } from '../../modules/collections';
import { parseNodeId } from '../../modules/navigation';

/** A project. A parameter that is not a positive id names nothing, and the screen says so. */
export default function ProjectRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();

  return <ProjectScreen projectId={parseNodeId(id)} />;
}
