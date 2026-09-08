import { View } from 'react-native';

import type { NoteResource } from '../../../infrastructure/api/contracts';
import { Card, type CardVariant, Wave } from '../../../ui';
import { CardSummary, CardTitle } from './card-text';
import { KindLabel } from './KindLabel';
import type { ResourceCardLayout } from './layout';

export interface NoteCardProps {
  resource: NoteResource;
  layout?: ResourceCardLayout | undefined;
  /**
   * Which surface the note sits on. Home draws notes on the warm card; the Area and Project
   * boards draw them on the lilac one, beside the other cards in the section.
   */
  variant?: CardVariant | undefined;
  onPress?: (() => void) | undefined;
  waveSeed?: number | undefined;
  testID?: string | undefined;
}

/**
 * A written note with the lilac wave the boards give it, on the warm surface by default and
 * on the lilac one where a section asks for it. Without `onPress` it is a plain surface: there
 * is no note detail screen in this build, so nothing passes one yet.
 */
export function NoteCard({
  resource,
  layout = 'column',
  variant = 'warm',
  onPress,
  waveSeed = 0,
  testID,
}: NoteCardProps) {
  return (
    <Card
      accessibilityLabel={`Note. ${resource.title}. ${resource.summary}`}
      onPress={onPress}
      testID={testID}
      variant={variant}
    >
      <Wave height={layout === 'full' ? 64 : 72} seed={waveSeed} variant="lilac" />
      <View className="p-4">
        <KindLabel background={false} kind="note" size={22} />
        <CardTitle className="mt-3">{resource.title}</CardTitle>
        <CardSummary className="mt-1">{resource.summary}</CardSummary>
      </View>
    </Card>
  );
}
