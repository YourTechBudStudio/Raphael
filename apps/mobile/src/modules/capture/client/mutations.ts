import { useMutation, useQueryClient } from '@tanstack/react-query';

import { localContent } from '../../../infrastructure/api';
import type { ContainerRef } from '../../../infrastructure/api/contracts';
import { useConnectionSession } from '../../connection';
import { invalidateResources } from '../../resources';

/**
 * Writing a note.
 *
 * Session-only, against the connection it was captured under. The destination is always an explicit
 * `ContainerRef` the person chose: there is no default target left to resolve, which is why there is
 * no location query beside this any more.
 */

export interface CreateNoteInput {
  parent: ContainerRef;
  title: string;
  body: string;
}

export function useCreateNote() {
  const client = useQueryClient();
  const session = useConnectionSession();
  const connectionId = session?.connection.connectionId ?? null;

  return useMutation({
    mutationFn: ({ parent, title, body }: CreateNoteInput) => {
      if (connectionId === null) throw new Error('No connection');

      return localContent.createNote(connectionId, parent, title, body);
    },
    onSuccess: () => {
      void invalidateResources(client);
    },
  });
}

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

  return useMutation({
    mutationFn: ({ parent, title, durationSeconds, waveform }: CreateVoiceNoteInput) => {
      if (connectionId === null) throw new Error('No connection');

      return localContent.createVoiceNote(connectionId, parent, title, durationSeconds, waveform);
    },
    onSuccess: () => {
      void invalidateResources(client);
    },
  });
}
