/**
 * Temporary: favorites mock for story #14. The floating "Mock" pill and the sheet of knobs behind it,
 * kept off the screen being judged so each screen looks as it would ship.
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
}

export function MockControls({ groups, note }: MockControlsProps) {
  const [open, setOpen] = useState(false);
  const insets = useSafeAreaInsets();

  return (
    <>
      <View
        pointerEvents="box-none"
        style={{ position: 'absolute', right: 16, bottom: insets.bottom + 24 }}
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
