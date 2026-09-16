import type { GetResponse } from '@raphael/contracts/nodes';

/** One note as the server describes it, body included. The only read that carries one. */
export type NoteEntity = GetResponse['entity'];
