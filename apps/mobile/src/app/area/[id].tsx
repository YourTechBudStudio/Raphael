import { useLocalSearchParams } from 'expo-router';

import { AreaScreen } from '../../modules/collections';
import { parseNodeId } from '../../modules/navigation';

/** An area. A parameter that is not a positive id names nothing, and the screen says so. */
export default function AreaRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();

  return <AreaScreen areaId={parseNodeId(id)} />;
}
