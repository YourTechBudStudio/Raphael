import type { ContainerRef, Resource, VoiceResource } from '../api/contracts';

/**
 * Session-only local content, kept per connection.
 *
 * Media captured in this session and favorites have no server operation in this release, so they
 * live here, in memory, for as long as the process does. Nothing in this module may be presented as
 * saved to Raphael.
 *
 * Notes are no longer among them. `createNote` wrote a note that existed only in this map, and the
 * feed that displayed it is gone; a note is created against the server now, by capture, and read
 * back by `modules/resources`. Nor is the active-project selection: it is a field on the project's
 * own row now, written through `nodes.update`, so it survives a restart and every client sees it.
 * What is left here is media and favorites, which have no server operation yet.
 *
 * Everything is keyed by connection id. Two servers can mint the same numeric id for different
 * containers, so a single flat store would show one server's notes under the other's areas. The
 * bucket is the isolation: a connection reads and writes only its own, and a connection that is
 * forgotten takes its bucket with it.
 *
 * A connection id is stable across a key rotation against the same address, which is why rotation
 * keeps these selections and switching servers does not.
 *
 * There are no fixtures. A fresh connection starts empty, because seeding it would mean guessing
 * which real container a fixture note belonged in, and every way of guessing - matching titles,
 * matching slugs, assuming seeded ids - invents a relationship the owner never expressed.
 */

interface Bucket {
  resources: readonly Resource[];
  favorites: readonly ContainerRef[];
}

const EMPTY: Bucket = { resources: [], favorites: [] };

const buckets = new Map<string, Bucket>();

const read = (connectionId: string): Bucket => buckets.get(connectionId) ?? EMPTY;

const write = (connectionId: string, next: Bucket): void => {
  buckets.set(connectionId, next);
};

const sameRef = (a: ContainerRef, b: ContainerRef): boolean => a.type === b.type && a.id === b.id;

const byNewest = (a: Resource, b: Resource): number => b.createdAt.localeCompare(a.createdAt);

let sequence = 0;

const nextId = (prefix: string): string => {
  sequence += 1;

  return `${prefix}-${String(sequence)}-${String(Date.now())}`;
};

export const localContent = {
  /** Every piece of session media captured against this connection, newest first. */
  async getResources(connectionId: string): Promise<Resource[]> {
    return [...read(connectionId).resources].sort(byNewest);
  },

  async createVoiceNote(
    connectionId: string,
    parent: ContainerRef,
    title: string,
    durationSeconds: number,
    waveform: readonly number[],
  ): Promise<VoiceResource> {
    const voice: VoiceResource = {
      id: nextId('voice'),
      kind: 'voice',
      title: title.trim() === '' ? 'Voice note' : title.trim(),
      summary: 'Recorded on this device.',
      parent,
      createdAt: new Date().toISOString(),
      durationSeconds,
      waveform: [...waveform],
    };
    const bucket = read(connectionId);
    write(connectionId, { ...bucket, resources: [voice, ...bucket.resources] });

    return voice;
  },

  /** Starred containers, in the order they were starred. References only, never titles. */
  async getFavorites(connectionId: string): Promise<ContainerRef[]> {
    return [...read(connectionId).favorites];
  },

  async toggleFavorite(connectionId: string, ref: ContainerRef): Promise<ContainerRef[]> {
    const bucket = read(connectionId);
    const starred = bucket.favorites.some((favorite) => sameRef(favorite, ref));
    const favorites = starred
      ? bucket.favorites.filter((favorite) => !sameRef(favorite, ref))
      : [...bucket.favorites, ref];
    write(connectionId, { ...bucket, favorites });

    return [...favorites];
  },

  /**
   * Drops everything held for a connection.
   *
   * Called on disconnect, not on a failed read. A hierarchy that did not load says nothing about
   * whether its containers still exist, and reaping local references on a network failure would
   * quietly destroy someone's stars the first time their server was unreachable.
   */
  forget(connectionId: string): void {
    buckets.delete(connectionId);
  },
};
