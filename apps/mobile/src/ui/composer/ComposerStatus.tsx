import { Text } from 'react-native';

export interface ComposerStatusProps {
  children: string;
  /**
   * `alert` is the error colour, for the one thing that outranks everything else: writing this
   * phone could not protect. Everything else is quiet.
   */
  tone?: 'quiet' | 'alert' | undefined;
  testID?: string | undefined;
}

/**
 * The line beside the close control, which is where this screen says what is true right now.
 *
 * A live region, because it changes without anyone touching it - a save completing, a draft being
 * written, a server answering - and a person who cannot see it changing should still be told.
 */
export function ComposerStatus({ children, tone = 'quiet', testID }: ComposerStatusProps) {
  return (
    <Text
      accessibilityLiveRegion="polite"
      className={`font-body text-[14px] ${tone === 'alert' ? 'text-danger' : 'text-ink-soft'}`}
      numberOfLines={2}
      testID={testID}
    >
      {children}
    </Text>
  );
}
