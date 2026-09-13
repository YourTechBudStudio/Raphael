import { useLocalSearchParams } from 'expo-router';

import { BrowseScreen } from '../modules/browse';
import { parseCollectionRef } from '../modules/navigation';

/** Browse. Optional `currentType` and `currentId` mark the location it was opened from. */
export default function BrowseRoute() {
  const { currentType, currentId } = useLocalSearchParams<{
    currentType?: string;
    currentId?: string;
  }>();

  return <BrowseScreen current={parseCollectionRef(currentType, currentId)} />;
}
