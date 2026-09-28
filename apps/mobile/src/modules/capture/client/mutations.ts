import { useMutation, useQueryClient } from '@tanstack/react-query';

import { localContent } from '../../../infrastructure/api';
import type { ContainerRef } from '../../../infrastructure/api/contracts';
import { useConnectionSession } from '../../connection';
import { invalidateSessionMedia } from '../../resources';

/**
 * Writing a voice note.
 *
 * Session-only, against the connection it was captured under, and honestly presented as such. The
 * destination is always an explicit `ContainerRef` the person chose: there is no default target.
 *
 * What it makes stale is this session's media, not the server's notes. They were one cache while
 * both lived in the same in-memory list; they are two now, and a recording has nothing to say about
 * what the server holds.
 *
 * Text notes are written through `unsent`. Voice has no server operation yet.
 */

export interface CreateVoiceNoteInput {
  parent: ContainerRef;
  title: string;
  durationSeconds: number;
  waveform: number[];
}

export function useCreateVoiceNote() {
  const client = useQueryClient();
  const session = useConnectionSession();
  const connectionId = session?.connection.connectionId ?? null;
  // Captured now, so the refresh lands in the caches this recording was made against even if the
  // connection changes before the mutation settles.
  const activation = session?.activation ?? -1;

  return useMutation({
    mutationFn: ({ parent, title, durationSeconds, waveform }: CreateVoiceNoteInput) => {
      if (connectionId === null) throw new Error('No connection');

      return localContent.createVoiceNote(connectionId, parent, title, durationSeconds, waveform);
    },
    onSuccess: () => {
      void invalidateSessionMedia(client, activation);
    },
  });
}
