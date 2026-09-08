import { Alert, Platform } from 'react-native';

export interface ConfirmDiscardOptions {
  /** The question, as a question ("Discard this note?"). */
  title: string;
  /** What is lost, stated plainly ("What you wrote will not be saved."). */
  message: string;
  /** The way back into the work ("Keep writing"). */
  keepLabel: string;
  discardLabel?: string | undefined;
}

/**
 * Asks whether unsaved work may be thrown away. Resolves true only on an explicit discard, so
 * every other way out of the dialog keeps the work.
 *
 * Web has no `Alert`, so it uses the browser's own confirm; native uses the platform dialog with
 * the discarding choice marked destructive.
 */
export function confirmDiscard({
  title,
  message,
  keepLabel,
  discardLabel = 'Discard',
}: ConfirmDiscardOptions): Promise<boolean> {
  if (Platform.OS === 'web') {
    return Promise.resolve(globalThis.confirm(`${title}\n\n${message}`));
  }

  return new Promise<boolean>((resolve) => {
    Alert.alert(
      title,
      message,
      [
        {
          text: keepLabel,
          style: 'cancel',
          onPress: () => {
            resolve(false);
          },
        },
        {
          text: discardLabel,
          style: 'destructive',
          onPress: () => {
            resolve(true);
          },
        },
      ],
      {
        cancelable: true,
        onDismiss: () => {
          resolve(false);
        },
      },
    );
  });
}
