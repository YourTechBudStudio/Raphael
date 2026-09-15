import { CircleAlert, CircleHelp, Layers, PenLine } from 'lucide-react-native';
import { Text, View } from 'react-native';

import type { NoteResource } from '../../../infrastructure/api/contracts';
import { Card, type CardVariant, colors } from '../../../ui';
import { CardSummary, CardTitle } from './card-text';
import { KindLabel } from './KindLabel';
import type { ResourceCardLayout } from './layout';

export interface NoteCardProps {
  resource: NoteResource;
  layout?: ResourceCardLayout | undefined;
  variant?: CardVariant | undefined;
  onPress?: (() => void) | undefined;
  waveSeed?: number | undefined;
  testID?: string | undefined;
}

/**
 * THROWAWAY (mock): how a note with no confirmed server copy announces itself. A draft is quiet;
 * a save the server has not answered, or refused, is said in the error colour because it asks
 * for a decision.
 */
const STATUS = {
  draft: {
    icon: PenLine,
    label: 'Draft · on this phone',
    color: colors.inkSoft,
    text: 'text-ink-soft',
  },
  unconfirmed: {
    icon: CircleHelp,
    label: 'Save not confirmed',
    color: colors.danger,
    text: 'text-danger',
  },
  refused: { icon: CircleAlert, label: 'Not saved', color: colors.danger, text: 'text-danger' },
} as const;

/**
 * A written note on the lilac surface, no wave. Where it is filed stands as the eyebrow: on a
 * board of notes the kind is known, and where a note lives is the more useful thing to read
 * first. A note with no location falls back to the kind label. Without `onPress` it is a plain
 * surface.
 */
export function NoteCard({ resource, variant = 'lilac', onPress, testID }: NoteCardProps) {
  const location = resource.location;
  const status = resource.status === undefined ? undefined : STATUS[resource.status];
  const Icon = status?.icon;

  return (
    <Card
      accessibilityLabel={`${status?.label ?? 'Note'}. ${resource.title}. ${resource.summary}${location === undefined ? '' : `. In ${location}`}`}
      // A draft is drawn with the dotted edge the ghost "New area" row uses: present, not yet
      // settled.
      className={resource.status === 'draft' ? 'border-dotted border-lilac' : undefined}
      onPress={onPress}
      testID={testID}
      variant={variant}
    >
      <View className="p-4">
        {status !== undefined && Icon !== undefined ? (
          <View className="flex-row items-center gap-1.5">
            <Icon color={status.color} size={16} strokeWidth={2} />
            <Text
              className={`flex-1 font-body-medium text-[14px] ${status.text}`}
              numberOfLines={1}
            >
              {status.label}
            </Text>
          </View>
        ) : location === undefined ? (
          <KindLabel background={false} kind="note" size={22} />
        ) : (
          <View className="flex-row items-center gap-1.5">
            <Layers color={colors.primary} size={16} strokeWidth={2} />
            <Text className="flex-1 font-body-medium text-[14px] text-primary" numberOfLines={1}>
              {location}
            </Text>
          </View>
        )}
        <CardTitle className="mt-3">{resource.title}</CardTitle>
        {resource.summary === '' ? null : (
          <CardSummary className="mt-1">{resource.summary}</CardSummary>
        )}
      </View>
    </Card>
  );
}
