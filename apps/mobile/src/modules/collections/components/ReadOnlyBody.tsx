import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

import type { ContainerType } from '../../../infrastructure/api/contracts';
import { SectionHeading } from '../../../ui';

export interface ReadOnlyBodyProps {
  /** The one-line summary from the container record. Empty when it has none. */
  description: string;
  /** The saved body as Markdown source. */
  body: string;
  /** Which kind of container this is. It becomes the word in "About this …". */
  kind: ContainerType;
  /** Drawn at the end of the heading row: the container's Edit action. */
  action?: ReactNode;
}

/**
 * Everything the container says about itself: its summary, then its saved body.
 *
 * The summary used to sit up under the title and the body down here, which read as two different
 * kinds of fact and are not - both are prose someone wrote about this container. Together they are
 * one section, and moving the summary down is what lets the header hold identity alone.
 *
 * The heading always renders, and says so when there is no prose yet. Edit sits at the end of the
 * heading row, so a section that disappeared with the prose would take the way to write some with it.
 *
 * Markdown source is presented as source rather than rendered: a heading marker or a list dash
 * stays visible. This is the safe representation for a body the app cannot edit yet, and it is
 * honest about what is stored. Paragraphs are split on blank lines so long bodies keep their
 * shape; nothing else is interpreted.
 *
 * It sits flat on the canvas with no card around it. A card says "separate object", and this is the
 * container's own words about itself, not a thing filed inside it.
 */
export function ReadOnlyBody({ description, body, kind, action }: ReadOnlyBodyProps) {
  const paragraphs = [description, ...body.split(/\n{2,}/)]
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '');

  return (
    <View className="mt-8 gap-4">
      <View className="flex-row items-center">
        <View className="flex-1">
          <SectionHeading>{`About this ${kind}`}</SectionHeading>
        </View>
        {action}
      </View>
      <View className="gap-3">
        {paragraphs.length === 0 ? (
          <Text className="font-body text-[16px] leading-[24px] text-ink-soft">
            {`Nothing written about this ${kind} yet.`}
          </Text>
        ) : null}
        {paragraphs.map((paragraph, index) => (
          <Text
            className="font-body text-[16px] leading-[24px] text-ink"
            key={`${index}:${paragraph.slice(0, 16)}`}
          >
            {paragraph}
          </Text>
        ))}
      </View>
    </View>
  );
}
