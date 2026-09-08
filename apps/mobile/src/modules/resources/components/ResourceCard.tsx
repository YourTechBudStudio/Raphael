import type { Resource } from '../../../infrastructure/api/contracts';
import type { CardVariant } from '../../../ui';
import { GithubCard } from './GithubCard';
import { ImageCard } from './ImageCard';
import type { ResourceCardLayout } from './layout';
import { NoteCard } from './NoteCard';
import { VoiceCard } from './VoiceCard';

export interface ResourceCardProps {
  resource: Resource;
  layout?: ResourceCardLayout | undefined;
  /** The surface written notes sit on in this section. Ignored by the other three kinds. */
  noteVariant?: CardVariant | undefined;
  onPress?: (() => void) | undefined;
  /** Varies the wave so neighbouring cards do not look stamped from one template. */
  waveSeed?: number | undefined;
  testID?: string | undefined;
}

/** Picks the card for a resource kind. Screens render this rather than the four cards. */
export function ResourceCard({
  resource,
  layout = 'column',
  noteVariant = 'warm',
  onPress,
  waveSeed = 0,
  testID,
}: ResourceCardProps) {
  switch (resource.kind) {
    case 'voice':
      return (
        <VoiceCard
          layout={layout}
          onPress={onPress}
          resource={resource}
          testID={testID}
          waveSeed={waveSeed}
        />
      );
    case 'image':
      return <ImageCard layout={layout} onPress={onPress} resource={resource} testID={testID} />;
    case 'github':
      return (
        <GithubCard
          layout={layout}
          onPress={onPress}
          resource={resource}
          testID={testID}
          waveSeed={waveSeed}
        />
      );
    case 'note':
      return (
        <NoteCard
          layout={layout}
          variant={noteVariant}
          onPress={onPress}
          resource={resource}
          testID={testID}
          waveSeed={waveSeed}
        />
      );
  }
}
