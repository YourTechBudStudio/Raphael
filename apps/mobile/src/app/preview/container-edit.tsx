/**
 * TEMPORARY PREVIEW for story #4. Presentation only: no queries, no owner, no server.
 *
 * An area screen with sample content and the settled Edit action in the header row beside
 * Favorite (program design §5.10). Delete before merge.
 */

import { ChevronDown, ChevronLeft, Layers, Pencil, Plus, Search } from 'lucide-react-native';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { CollectionTile } from '../../modules/collections';
import { goBack } from '../../modules/navigation';
import {
  Chip,
  colors,
  Eyebrow,
  FAVORITE_MARK,
  IconButton,
  PressableFeedback,
  Screen,
  SectionHeading,
  ToggleLabel,
} from '../../ui';

const TITLE = 'Raphael';
const DESCRIPTION = 'A second brain for agents. PARA and CODE, as actionable notes.';
const BODY =
  'Everything about Raphael lives under here: the product, the mobile app, the backend and the CLI.\n\nProjects are the things with an end. Areas are the things without one.';

export default function ContainerEditPreview() {
  const [favorite, setFavorite] = useState(true);

  const header = (
    <View className="h-14 flex-row items-center gap-2">
      <IconButton icon={ChevronLeft} label="Back" onPress={goBack} />
      <Chip
        accessibilityHint="Opens the list of areas and projects"
        icon={Layers}
        label="Areas"
        onPress={() => undefined}
        style={{ flex: 1 }}
        trailingIcon={ChevronDown}
      />
      <IconButton icon={Search} label="Search" onPress={() => undefined} />
      <IconButton
        accessibilityHint="Adds an area or a project inside this one"
        className="bg-primary-soft"
        icon={Plus}
        label="Add"
        onPress={() => undefined}
      />
    </View>
  );

  return (
    <Screen header={header}>
      <View>
        <Eyebrow>Area</Eyebrow>
        <Text
          accessibilityRole="header"
          className="mt-1 font-heading text-ink"
          numberOfLines={2}
          style={{ fontSize: 40, lineHeight: 46 }}
        >
          {TITLE}
        </Text>
        <View className="mt-4 flex-row flex-wrap items-center gap-x-5 gap-y-1">
          <ToggleLabel
            accessibilityLabel={
              favorite ? `Remove ${TITLE} from favorites` : `Add ${TITLE} to favorites`
            }
            label="Favorite"
            mark={FAVORITE_MARK}
            onToggle={() => {
              setFavorite((value) => !value);
            }}
            selected={favorite}
          />
          <PressableFeedback
            accessibilityHint="Changes this area’s title, description, body, ID and tags"
            accessibilityLabel="Edit this area"
            accessibilityRole="button"
            className="h-11 flex-row items-center gap-1 pr-2"
            onPress={() => undefined}
          >
            <View className="items-center justify-center" style={{ height: 44, width: 44 }}>
              <Pencil color={colors.primary} size={20} strokeWidth={2} />
            </View>
            <Text className="font-body-medium text-[16px] text-ink">Edit</Text>
          </PressableFeedback>
        </View>
      </View>

      <View className="mt-8 gap-4">
        <SectionHeading>About this area</SectionHeading>
        <View className="gap-3">
          {[DESCRIPTION, ...BODY.split(/\n{2,}/)].map((paragraph) => (
            <Text className="font-body text-[16px] leading-[24px] text-ink" key={paragraph}>
              {paragraph}
            </Text>
          ))}
        </View>
      </View>

      <View className="mt-8 gap-3">
        <SectionHeading>Projects</SectionHeading>
        <View className="flex-row gap-3">
          <CollectionTile
            className="flex-1"
            description="Editing, story #4"
            emblem="petals"
            name="Mobile"
            onPress={() => undefined}
          />
          <CollectionTile
            className="flex-1"
            description="Update route and CLI"
            emblem="arch"
            name="Backend"
            onPress={() => undefined}
          />
        </View>
      </View>
    </Screen>
  );
}
