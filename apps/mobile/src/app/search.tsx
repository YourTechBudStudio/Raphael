import { useLocalSearchParams } from 'expo-router';

import { parseCollectionRef } from '../modules/navigation';
import { SearchScreen } from '../modules/search';

/** Search, presented as a modal. Optional `scopeType` and `scopeId` limit it to one subtree. */
export default function SearchRoute() {
  const { scopeType, scopeId } = useLocalSearchParams<{
    scopeType?: string;
    scopeId?: string;
  }>();

  return <SearchScreen scope={parseCollectionRef(scopeType, scopeId)} />;
}
