import { Text, View } from 'react-native';

import { SectionHeading } from '../../../ui';

export interface ReadOnlyBodyProps {
  /** The saved body as Markdown source. Nothing renders when it is empty. */
  body: string;
  /** "area" or "project", for the heading. */
  kind: string;
}

/**
 * The saved body, read-only and shown as the text that was written.
 *
 * Markdown source is presented as source rather than rendered: a heading marker or a list dash
 * stays visible. This is the safe representation for a body the app cannot edit yet, and it is
 * honest about what is stored. Paragraphs are split on blank lines so long bodies keep their
 * shape; nothing else is interpreted.
 */
export function ReadOnlyBody({ body, kind }: ReadOnlyBodyProps) {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '');

  if (paragraphs.length === 0) {
    return null;
  }

  return (
    <View className="mt-8 gap-4">
      <SectionHeading>{`About this ${kind}`}</SectionHeading>
      <View className="gap-3 rounded-card border border-line bg-card px-5 py-5">
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
