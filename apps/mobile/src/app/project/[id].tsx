import { useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { CaptureDock } from '../../modules/capture';
import { ProjectScreen, useContainerArchived } from '../../modules/collections';
import { parseNodeId } from '../../modules/navigation';

/** A project. A parameter that is not a positive id names nothing, and the screen says so. */
export default function ProjectRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const projectId = parseNodeId(id);
  // The same Get the screen makes, so this asks nothing of its own.
  const archived = useContainerArchived(
    projectId === null ? null : { type: 'project', id: projectId },
  );

  return (
    <View className="flex-1">
      <ProjectScreen projectId={projectId} />
      <CaptureDock unavailable={archived === true} />
    </View>
  );
}
