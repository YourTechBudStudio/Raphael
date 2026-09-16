import type { Resource } from '../../../infrastructure/api/contracts';
import { GithubCard } from './GithubCard';
import { ImageCard } from './ImageCard';
import type { ResourceCardLayout } from './layout';
import { VoiceCard } from './VoiceCard';

export interface ResourceCardProps {
  resource: Resource;
  layout?: ResourceCardLayout | undefined;
  onPress?: (() => void) | undefined;
  /** Varies the wave so neighbouring cards do not look stamped from one template. */
  waveSeed?: number | undefined;
  testID?: string | undefined;
}

/**
 * Picks the card for a session-media kind.
 *
 * The note branch is gone. A note is server data with a different shape, and `NoteCard` takes that
 * shape directly rather than being reached through a union it no longer belongs to.
 */
export function ResourceCard({
  resource,
  layout = 'column',
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
  }
}
