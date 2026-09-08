import clsx from 'clsx';
import type { ReactNode } from 'react';
import { View } from 'react-native';

export interface SkeletonBlockProps {
  height: number;
  /** Left out, the block fills the width it is given. */
  width?: number | undefined;
}

/**
 * A placeholder for the ~120 ms the mock repository takes. It is the size and shape of the
 * content that replaces it, and it does not animate: a spinner that comes and goes within a
 * blink is noise, and a shimmer would break "calm at rest".
 */
export function SkeletonBlock({ height, width }: SkeletonBlockProps) {
  return (
    <View
      className="rounded-card border border-line bg-card"
      style={width === undefined ? { flex: 1, height } : { height, width }}
    />
  );
}

export interface SkeletonGroupProps {
  /** What is loading, said once for the whole group ("Loading favorites"). */
  label: string;
  children: ReactNode;
  className?: string | undefined;
}

/**
 * Wraps a set of placeholders so a screen reader hears "loading" once. Without it the blocks
 * carry no meaning of their own and the screen would announce nothing at all while it waits.
 */
export function SkeletonGroup({ label, children, className }: SkeletonGroupProps) {
  return (
    <View
      accessible
      accessibilityLabel={label}
      accessibilityRole="progressbar"
      className={clsx(className)}
    >
      {children}
    </View>
  );
}
