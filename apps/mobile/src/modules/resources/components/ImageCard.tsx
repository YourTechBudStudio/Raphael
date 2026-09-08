import { Image } from 'expo-image';
import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import type { ImageResource } from '../../../infrastructure/api/contracts';
import { Card, colors } from '../../../ui';
import { CardSummary, CardTitle } from './card-text';
import { KindLabel } from './KindLabel';
import type { ResourceCardLayout } from './layout';

/** Height of the curved band where the caption panel climbs over the photo. */
const CURVE_HEIGHT = 34;

const CURVE_PATH = 'M0 16 C 20 2, 44 34, 70 24 C 84 19, 93 14, 100 14 L100 40 L0 40 Z';

export interface ImageCardProps {
  resource: ImageResource;
  layout?: ResourceCardLayout | undefined;
  onPress?: (() => void) | undefined;
  testID?: string | undefined;
}

/**
 * A photograph with a warm caption panel below it. The boundary is a curve, not a
 * straight cut: the panel is drawn as a wave that overlaps the bottom of the photo.
 */
export function ImageCard({ resource, layout = 'column', onPress, testID }: ImageCardProps) {
  const photoHeight = layout === 'full' ? 150 : 220;

  return (
    <Card
      accessibilityLabel={`Image. ${resource.title}. ${resource.summary}`}
      onPress={onPress}
      testID={testID}
      variant="warm"
    >
      <Image
        accessibilityElementsHidden
        contentFit="cover"
        importantForAccessibility="no-hide-descendants"
        source={resource.image}
        style={{ height: photoHeight, width: '100%' }}
        transition={200}
      />
      <View style={{ marginTop: -CURVE_HEIGHT }}>
        <Svg height={CURVE_HEIGHT} preserveAspectRatio="none" viewBox="0 0 100 40" width="100%">
          <Path d={CURVE_PATH} fill={colors.cardWarm} />
        </Svg>
        <View className="bg-card-warm px-4 pb-5" style={{ marginTop: -1 }}>
          <KindLabel background={false} kind="image" size={22} />
          <CardTitle className="mt-3">{resource.title}</CardTitle>
          <CardSummary className="mt-1">{resource.summary}</CardSummary>
        </View>
      </View>
    </Card>
  );
}
