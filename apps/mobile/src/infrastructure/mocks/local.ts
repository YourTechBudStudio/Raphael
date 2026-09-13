import type { ContainerRef, NoteResource, Resource, VoiceResource } from '../api/contracts';

/**
 * Session-only local content, kept per connection.
 *
 * Notes, favorites, and active-project selections have no server operation in this release, so
 * they live here, in memory, for as long as the process does. Phase 08 changed what they *point
 * at* - real numeric container ids instead of fixture strings - and nothing about how long they
 * last. Nothing in this module may be presented as saved to Raphael.
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

/** Simulated latency, so the loading states these screens were designed with are still real. */
const LATENCY_MS = 120;

const delay = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, LATENCY_MS);
  });

interface Bucket {
  resources: readonly Resource[];
  favorites: readonly ContainerRef[];
  activeProjectIds: readonly number[];
}

const EMPTY: Bucket = { resources: [], favorites: [], activeProjectIds: [] };

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
  /** Everything captured against this connection, newest first. */
  async getResources(connectionId: string): Promise<Resource[]> {
    await delay();

    return [...read(connectionId).resources].sort(byNewest);
  },

  async createNote(
    connectionId: string,
    parent: ContainerRef,
    title: string,
    body: string,
  ): Promise<NoteResource> {
    await delay();

    const note: NoteResource = {
      id: nextId('note'),
      kind: 'note',
      title: title.trim() === '' ? 'Untitled note' : title.trim(),
      summary: body.trim(),
      parent,
      createdAt: new Date().toISOString(),
    };
    const bucket = read(connectionId);
    write(connectionId, { ...bucket, resources: [note, ...bucket.resources] });

    return note;
  },

  async createVoiceNote(
    connectionId: string,
    parent: ContainerRef,
    title: string,
    durationSeconds: number,
    waveform: readonly number[],
  ): Promise<VoiceResource> {
    await delay();

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
    await delay();

    return [...read(connectionId).favorites];
  },

  async toggleFavorite(connectionId: string, ref: ContainerRef): Promise<ContainerRef[]> {
    await delay();

    const bucket = read(connectionId);
    const starred = bucket.favorites.some((favorite) => sameRef(favorite, ref));
    const favorites = starred
      ? bucket.favorites.filter((favorite) => !sameRef(favorite, ref))
      : [...bucket.favorites, ref];
    write(connectionId, { ...bucket, favorites });

    return [...favorites];
  },

  /** Deliberately active projects, by id, in selection order. */
  async getActiveProjects(connectionId: string): Promise<number[]> {
    await delay();

    return [...read(connectionId).activeProjectIds];
  },

  async setProjectActive(connectionId: string, id: number, active: boolean): Promise<void> {
    await delay();

    const bucket = read(connectionId);
    const present = bucket.activeProjectIds.includes(id);

    if (active === present) return;

    write(connectionId, {
      ...bucket,
      activeProjectIds: active
        ? [...bucket.activeProjectIds, id]
        : bucket.activeProjectIds.filter((candidate) => candidate !== id),
    });
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
