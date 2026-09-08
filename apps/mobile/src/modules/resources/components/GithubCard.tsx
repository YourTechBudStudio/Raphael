import { View } from 'react-native';

import type { GithubResource } from '../../../infrastructure/api/contracts';
import { Card } from '../../../ui';
import { CardSummary, CardTitle } from './card-text';
import { KindLabel } from './KindLabel';
import type { ResourceCardLayout } from './layout';

export interface GithubCardProps {
  resource: GithubResource;
  layout?: ResourceCardLayout | undefined;
  onPress?: (() => void) | undefined;
  waveSeed?: number | undefined;
  testID?: string | undefined;
}

/** A linked repository, titled `owner / repo` the way the boards write it. */
export function GithubCard({
  resource,
  layout = 'column',
  onPress,
  waveSeed = 0,
  testID,
}: GithubCardProps) {
  return (
    <Card
      accessibilityLabel={`GitHub repository. ${resource.title}. ${resource.summary}`}
      onPress={onPress}
      testID={testID}
      wave
      waveHeight={layout === 'full' ? 64 : 72}
      waveSeed={waveSeed}
    >
      <View className="p-4">
        <KindLabel background={false} kind="github" size={26} />
        <CardTitle className="mt-3">{resource.title}</CardTitle>
        <CardSummary className="mt-1">{resource.summary}</CardSummary>
      </View>
    </Card>
  );
}
