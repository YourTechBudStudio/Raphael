import type { Rejection } from '../state/connection';

/** What a refusal means, in the words every screen that shows one uses. */
export const rejectionCopy = (
  rejection: Rejection,
): { readonly title: string; readonly detail: string } =>
  rejection === 'unauthorized'
    ? {
        title: 'That key was refused.',
        detail:
          'The server answered, and it does not accept the key this device is holding. Nothing has been deleted here, and nothing on the server has changed.',
      }
    : {
        title: 'A different version of Raphael.',
        detail:
          'The server answered with a protocol this app does not understand. One of the two needs updating; nothing here is broken.',
      };
