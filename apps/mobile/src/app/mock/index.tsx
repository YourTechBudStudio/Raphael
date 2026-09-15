import { router } from 'expo-router';

import { MockGallery } from '../../modules/mock';

/** THROWAWAY MOCK ROUTE. */
export default function MockGalleryRoute() {
  return (
    <MockGallery
      onBack={() => {
        router.back();
      }}
      onOpen={() => {
        router.push('/mock/composer');
      }}
      onOpenUnfinished={() => {
        router.push('/mock/unfinished');
      }}
      onOpenSetup={() => {
        router.push('/mock/setup');
      }}
    />
  );
}
