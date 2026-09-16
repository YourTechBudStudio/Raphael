import { useLocalSearchParams } from 'expo-router';

import { openHome, parseNodeId } from '../../modules/navigation';
import { NoteScreen } from '../../modules/resources';

export default function ResourceRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();

  return <NoteScreen id={parseNodeId(id)} onClose={openHome} />;
}
