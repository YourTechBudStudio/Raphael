/**
 * Temporary: archive mock for story #8. The floating "Mock" pill and the sheet of knobs behind it.
 *
 * Kept off the screen being judged, so each screen looks as it would ship; the knobs pick which
 * archive standing is drawn and whether the next save fails.
 */

import { SlidersHorizontal, X } from 'lucide-react-native';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Chip, IconButton, SectionHeading, Sheet, SheetHeader } from '../../../../ui';

export interface MockControlGroup {
  readonly title: string;
  readonly options: readonly { key: string; label: string }[];
  readonly value: string;
  readonly onChange: (key: string) => void;
}

export interface MockControlsProps {
  groups: readonly MockControlGroup[];
  /** One sentence under the groups: what to try on this screen. */
  note?: string | undefined;
  /** Distance from the bottom edge, above whatever bar the screen has. */
  bottom?: number | undefined;
}

export function MockControls({ groups, note, bottom = 24 }: MockControlsProps) {
  const [open, setOpen] = useState(false);
  const insets = useSafeAreaInsets();

  return (
    <>
      <View
        pointerEvents="box-none"
        style={{ position: 'absolute', right: 16, bottom: insets.bottom + bottom }}
      >
        <Chip
          accessibilityHint="Opens the mock's state picker"
          icon={SlidersHorizontal}
          label="Mock"
          onPress={() => {
            setOpen(true);
          }}
          selected
        />
      </View>
      <Sheet
        className="gap-5 px-5 pb-6 pt-3"
        label="the mock controls"
        onClose={() => {
          setOpen(false);
        }}
        visible={open}
      >
        <SheetHeader
          leading={
            <IconButton
              icon={X}
              label="Close"
              onPress={() => {
                setOpen(false);
              }}
            />
          }
          subtitle="Invented data. Nothing is sent to your server."
          title="Mock"
          trailing={<View className="w-11" />}
        />
        {groups.map((group) => (
          <View className="gap-3" key={group.title}>
            <SectionHeading>{group.title}</SectionHeading>
            <View className="flex-row flex-wrap gap-2">
              {group.options.map((option) => (
                <Chip
                  key={option.key}
                  label={option.label}
                  onPress={() => {
                    group.onChange(option.key);
                  }}
                  selected={group.value === option.key}
                />
              ))}
            </View>
          </View>
        ))}
        {note === undefined ? null : (
          <Text className="font-body text-[15px] leading-[22px] text-ink-soft">{note}</Text>
        )}
      </Sheet>
    </>
  );
}
