import { useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { CaptureDock } from '../../modules/capture';
import { AreaScreen, useContainerArchived } from '../../modules/collections';
import { parseNodeId } from '../../modules/navigation';

/**
 * An area. A parameter that is not a positive id names nothing, and the screen says so.
 *
 * The capture pair is mounted here rather than inside the screen so that `collections` never has to
 * know that capture exists: capture reads the hierarchy to name where a note is going, and the
 * dependency stays pointing one way.
 */
export default function AreaRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const areaId = parseNodeId(id);
  // The same Get the screen makes, so this asks nothing of its own.
  const archived = useContainerArchived(areaId === null ? null : { type: 'area', id: areaId });

  return (
    <View className="flex-1">
      <AreaScreen areaId={areaId} />
      <CaptureDock unavailable={archived === true} />
    </View>
  );
}
