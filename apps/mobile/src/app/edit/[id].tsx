import { useLocalSearchParams } from 'expo-router';

import { EditScreen } from '../../modules/capture';
import { parseNodeId } from '../../modules/navigation';

export default function EditRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();

  return <EditScreen id={parseNodeId(id)} />;
}
