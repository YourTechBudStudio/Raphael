import { useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { CaptureDock } from '../../modules/capture';
import { ProjectScreen } from '../../modules/collections';
import { parseNodeId } from '../../modules/navigation';

/** A project. A parameter that is not a positive id names nothing, and the screen says so. */
export default function ProjectRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();

  return (
    <View className="flex-1">
      <ProjectScreen projectId={parseNodeId(id)} />
      <CaptureDock />
    </View>
  );
}
