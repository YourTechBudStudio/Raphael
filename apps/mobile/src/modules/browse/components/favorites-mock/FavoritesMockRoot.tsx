/**
 * Temporary: favorites mock for story #14. One route, two screens, one final design.
 * Delete this folder, its export in `browse/index.ts`, `app/mock-favorites.tsx` and the Settings chip.
 */

import { useState } from 'react';
import { Text, View } from 'react-native';

import { Chip, Screen, SectionHeading } from '../../../../ui';
import { goBack, TitleTopBar } from '../../../navigation';
import { FavoritesMock } from './FavoritesMock';
import { SearchMock } from './SearchMock';

type MockScreen = 'home' | 'favorites' | 'search';

export function FavoritesMockRoot() {
  const [screen, setScreen] = useState<MockScreen>('home');
  const home = () => {
    setScreen('home');
  };

  if (screen === 'favorites') {
    return <FavoritesMock onBack={home} />;
  }

  if (screen === 'search') {
    return <SearchMock onBack={home} />;
  }

  return (
    <Screen captureBar={false} header={<TitleTopBar onBack={goBack} title="Favorites mock" />}>
      <View className="gap-7 pt-2">
        <Text className="font-body text-[16px] leading-[24px] text-ink">
          Story #14, presentation only. The final design: Favorites and Search share one two-line
          row on the new shape marks. The Mock pill on each screen switches states, not designs.
        </Text>
        <View className="gap-3">
          <SectionHeading>Open</SectionHeading>
          <View className="flex-row flex-wrap gap-2">
            <Chip
              label="Browse → Favorites"
              onPress={() => {
                setScreen('favorites');
              }}
            />
            <Chip
              label="Search"
              onPress={() => {
                setScreen('search');
              }}
            />
          </View>
        </View>
        <View className="gap-3">
          <SectionHeading>Try</SectionHeading>
          <Text className="font-body text-[15px] leading-[22px] text-ink-soft">
            On Favorites, unstar a row and watch it leave, then make the next tap slow or fail. On
            Search, scroll to the end to load more, make the next page fail, and include archived.
          </Text>
        </View>
      </View>
    </Screen>
  );
}
