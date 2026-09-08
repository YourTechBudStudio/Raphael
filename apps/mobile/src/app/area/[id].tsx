import { useLocalSearchParams } from 'expo-router';

import { AreaScreen } from '../../modules/collections';

export default function AreaRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();

  // A malformed link leaves the id missing; the screen owns the "we could not find that" state.
  return <AreaScreen areaId={id ?? ''} />;
}
