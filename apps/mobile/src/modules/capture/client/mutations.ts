import { useMutation, useQueryClient } from '@tanstack/react-query';

import { mobileApi } from '../../../infrastructure/api';
import type { CaptureTarget } from '../../../infrastructure/api/contracts';
import { invalidateResourceViews } from '../../resources';

export interface CreateNoteInput {
  target: CaptureTarget;
  title: string;
  body: string;
}

export function useCreateNote() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ target, title, body }: CreateNoteInput) =>
      mobileApi.createNote(target, title, body),
    onSuccess: () => {
      void invalidateResourceViews(client);
    },
  });
}

export interface CreateVoiceNoteInput {
  target: CaptureTarget;
  title: string;
  durationSeconds: number;
  waveform: number[];
}

export function useCreateVoiceNote() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ target, title, durationSeconds, waveform }: CreateVoiceNoteInput) =>
      mobileApi.createVoiceNote(target, title, durationSeconds, waveform),
    onSuccess: () => {
      void invalidateResourceViews(client);
    },
  });
}
